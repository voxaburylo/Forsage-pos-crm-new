import { z } from 'zod'
import { pool } from '../../db/pg.js'
import { AppError } from '../../middleware/errorHandler.js'
import { BULK_TOP, PhotoAiLater, PhotoAiStop, STOP_TEXT, type PhotoStopReason } from './photoSearch.js'
import { addUsage, readKeys, readSettings, type PhotoAiKeys, type PhotoAiSettings, type PhotoCalls } from './photoAiConfig.js'
import { findPhotos } from './photoFinder.js'
import { storePhoto } from './photoStore.js'
import { productSchema, rememberSearch, SEARCH_AGAIN_DAYS, type FindDeps } from './photoFinds.js'

/**
 * «Фото ШІ», масовий режим: партія товарів без фото, черга у фоні.
 * Гроші: кожен товар — 1 запит Serper і до 6 запитів Gemini, тому партії малі (до 50 товарів), лічильник видно на
 * екрані, а «закінчились кредити» чи поганий ключ зупиняють чергу з поясненням.
 * Навантаження: будильник бази стукає щохвилини; за одне пробудження — кілька товарів, кожен запис у базу — окремий
 * короткий запит, без довгих блокувань. Коли база зайнята, крок пропускається (routes/internalAi.ts).
 */
export const BATCH_MAX = 50
export const ELIGIBLE_MAX = 500
/** Скільки товарів одночасно й скільки часу на одне пробудження. Новий товар не починаємо, якщо лишилось мало часу. */
export const QUEUE_PARALLEL = 2, QUEUE_RUN_MS = 45_000, QUEUE_ITEM_MS = 30_000, QUEUE_STALE_CLAIM = '5 minutes'
/** Після 429/503 чекаємо дедалі довше; після стількох невдач поспіль — зупинка з поясненням (схоже на денний ліміт). */
export const RETRY_MINUTES = [2, 5, 10, 20, 30], RETRY_LIMIT = 12

export const createBatchSchema = z.object({ mode: z.enum(['review', 'auto']).default('review'), products: z.array(productSchema).min(1).max(BATCH_MAX) })
export const eligibleSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(ELIGIBLE_MAX) })

interface JobRow { id: string; tenant_id: string; mode: 'review' | 'auto'; status: string; stop_reason: string | null; total: number; done: number; found: number
  serper_calls: number; gemini_calls: number; retry_at: Date | null; retries: number; created_at: Date; finished_at: Date | null }
interface ItemRow { job_id: string; product_id: string; name: string; sku: string | null; brand: string | null }

const stopText = (reason: string | null) => !reason || reason === 'user' ? null : STOP_TEXT[reason as PhotoStopReason] ?? null
export function publicJob(row: JobRow) {
  return { id: row.id, mode: row.mode, status: row.status, stop_reason: row.stop_reason, stop_text: stopText(row.stop_reason), total: row.total, done: row.done, found: row.found,
    serper_calls: row.serper_calls, gemini_calls: row.gemini_calls, waiting_until: row.retry_at && row.status === 'running' ? new Date(row.retry_at).toISOString() : null,
    created_at: new Date(row.created_at).toISOString(), finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null }
}

/**
 * Які з товарів варто шукати: не шукали останні 30 днів без результату, немає знайдених фото, що чекають рішення чи
 * картки, і товар не стоїть у незавершеній партії. Чи є в товару фото — знає каса: вона надсилає лише товари без фото.
 */
export async function eligibleIds(tenantId: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)]
  const { rows } = await pool.query(
    `SELECT x.id FROM unnest($2::uuid[]) AS x(id)
      WHERE NOT EXISTS (SELECT 1 FROM photo_ai_searches s WHERE s.tenant_id = $1 AND s.product_id = x.id AND s.searched_at > now() - make_interval(days => $3))
        AND NOT EXISTS (SELECT 1 FROM photo_ai_finds f WHERE f.tenant_id = $1 AND f.product_id = x.id AND f.state IN ('pending', 'approved'))
        AND NOT EXISTS (SELECT 1 FROM photo_ai_items i JOIN photo_ai_jobs j ON j.id = i.job_id
                         WHERE j.tenant_id = $1 AND j.status IN ('running', 'stopped') AND i.product_id = x.id AND i.state = 'pending')`, [tenantId, unique, SEARCH_AGAIN_DAYS])
  const allowed = new Set(rows.map((row: { id: string }) => row.id))
  return unique.filter(id => allowed.has(id))
}

export async function latestJob(tenantId: string) {
  const row = (await pool.query('SELECT * FROM photo_ai_jobs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1', [tenantId])).rows[0] as JobRow | undefined
  return row ? publicJob(row) : null
}

export async function createBatch(tenantId: string, userId: string | null, input: z.infer<typeof createBatchSchema>) {
  const keys = await readKeys(tenantId)
  if (!keys.serper || !keys.gemini) throw new AppError('PHOTO_AI_NOT_READY', 'Спершу власник має вставити ключі Serper.dev і Gemini в налаштуваннях «Фото ШІ».', 400)
  const active = (await pool.query("SELECT id FROM photo_ai_jobs WHERE tenant_id = $1 AND status = 'running' LIMIT 1", [tenantId])).rows[0]
  if (active) throw new AppError('PHOTO_AI_RUNNING', 'Попередня партія ще працює. Дочекайтесь її або натисніть «Стоп».', 409)
  const allowed = new Set(await eligibleIds(tenantId, input.products.map(product => product.id)))
  const products = input.products.filter((product, index, all) => allowed.has(product.id) && all.findIndex(other => other.id === product.id) === index)
  if (!products.length) throw new AppError('PHOTO_AI_NOTHING', `Усі ці товари вже шукали за останні ${SEARCH_AGAIN_DAYS} днів або їхні фото чекають рішення.`, 422)
  const job = (await pool.query('INSERT INTO photo_ai_jobs (tenant_id, created_by, mode, total) VALUES ($1, $2, $3, $4) RETURNING *', [tenantId, userId, input.mode, products.length])).rows[0] as JobRow
  await pool.query(
    `INSERT INTO photo_ai_items (job_id, product_id, position, name, sku, brand)
     SELECT $1, x.id, x.position, x.name, NULLIF(x.sku, ''), NULLIF(x.brand, '')
       FROM unnest($2::uuid[], $3::int[], $4::text[], $5::text[], $6::text[]) AS x(id, position, name, sku, brand)`,
    [job.id, products.map(p => p.id), products.map((_, index) => index), products.map(p => p.name), products.map(p => p.sku ?? ''), products.map(p => p.brand ?? '')])
  return { job: publicJob(job), skipped: input.products.length - products.length }
}

export async function changeBatch(tenantId: string, id: string, action: 'stop' | 'resume') {
  const row = action === 'stop'
    ? (await pool.query("UPDATE photo_ai_jobs SET status = 'stopped', stop_reason = 'user', updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'running' RETURNING *", [tenantId, id])).rows[0]
    : (await pool.query(
      `UPDATE photo_ai_jobs SET status = 'running', stop_reason = NULL, retry_at = NULL, retries = 0, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND status = 'stopped'
          AND NOT EXISTS (SELECT 1 FROM photo_ai_jobs other WHERE other.tenant_id = $1 AND other.status = 'running') RETURNING *`, [tenantId, id])).rows[0]
  if (!row) throw new AppError('PHOTO_AI_STATE', action === 'stop' ? 'Ця партія вже не працює.' : 'Продовжити можна лише зупинену партію, коли не працює інша.', 409)
  return publicJob(row as JobRow)
}

/** Ніч за київським часом: 22:00–07:00. */
export function isNight(now: Date): boolean {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false }).format(now)) % 24
  return hour >= 22 || hour < 7
}

async function claimItems(jobId: string, limit: number): Promise<ItemRow[]> {
  const { rows } = await pool.query(
    `UPDATE photo_ai_items SET claimed_at = now()
      WHERE (job_id, product_id) IN (
        SELECT job_id, product_id FROM photo_ai_items
         WHERE job_id = $1 AND state = 'pending' AND (claimed_at IS NULL OR claimed_at < now() - interval '${QUEUE_STALE_CLAIM}')
         ORDER BY position LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING job_id, product_id, name, sku, brand`, [jobId, limit])
  return rows as ItemRow[]
}

type ItemOutcome = { kind: 'done'; found: number } | { kind: 'stop'; reason: PhotoStopReason } | { kind: 'later' }

/** Один товар партії: пошук → перевірка → стиснення й сховище → знахідки. Лічильники пишуться за будь-якого кінця. */
export async function processItem(job: Pick<JobRow, 'id' | 'tenant_id' | 'mode'>, item: ItemRow, settings: PhotoAiSettings, keys: PhotoAiKeys, deps: FindDeps = {}): Promise<ItemOutcome> {
  const calls: PhotoCalls = { serper: 0, gemini: 0 }
  const product = { id: item.product_id, name: item.name, sku: item.sku, brand: item.brand }
  let outcome: ItemOutcome, note: string | null = null, state: 'found' | 'none' | 'failed' | null = null
  try {
    const checked = await findPhotos(product, settings, keys, calls, { top: BULK_TOP, need: settings.photos_per_product }, deps, AbortSignal.timeout(QUEUE_ITEM_MS))
    const good = checked.filter(photo => photo.ok && photo.bytes).slice(0, settings.photos_per_product)
    let saved = 0
    for (const photo of good) {
      try {
        const stored = await storePhoto(job.tenant_id, product.id, photo.bytes!, deps)
        await pool.query(
          `INSERT INTO photo_ai_finds (tenant_id, product_id, job_id, position, url, thumb_url, source_url, source_page, product_name, verdict, state, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [job.tenant_id, product.id, job.id, saved, stored.url, stored.thumb_url, photo.image_url.slice(0, 1500), photo.page_url.slice(0, 1500) || null, product.name,
            JSON.stringify(photo.verdict), job.mode === 'auto' ? 'approved' : 'pending', job.mode === 'auto' ? new Date() : null])
        saved += 1
      } catch { /* це фото не збереглось — пробуємо наступне */ }
    }
    await rememberSearch(job.tenant_id, product.id, saved > 0)
    state = saved > 0 ? 'found' : 'none'
    note = saved > 0 ? null : checked.length ? ('ШІ відхилив усі ' + checked.length + ': ' + [...new Set(checked.map(photo => photo.reason))].slice(0, 3).join('; ')).slice(0, 300) : 'пошук не дав підхожих картинок'
    outcome = { kind: 'done', found: saved }
  } catch (error) {
    if (error instanceof PhotoAiStop) outcome = { kind: 'stop', reason: error.reason }
    else if (error instanceof PhotoAiLater || (error instanceof Error && error.name === 'TimeoutError')) outcome = { kind: 'later' }
    else { state = 'failed'; note = (error instanceof Error ? error.message : 'помилка').slice(0, 300); outcome = { kind: 'done', found: 0 } }
  }
  await addUsage(job.tenant_id, calls).catch(() => undefined)
  if (state) {
    await pool.query('UPDATE photo_ai_items SET state = $3, note = $4, done_at = now() WHERE job_id = $1 AND product_id = $2', [job.id, item.product_id, state, note])
    await pool.query('UPDATE photo_ai_jobs SET done = done + 1, found = found + $2, serper_calls = serper_calls + $3, gemini_calls = gemini_calls + $4, retries = 0, retry_at = NULL, updated_at = now() WHERE id = $1',
      [job.id, state === 'found' ? 1 : 0, calls.serper, calls.gemini])
  } else {
    // Товар повертається в чергу; витрачені запити все одно рахуємо.
    await pool.query('UPDATE photo_ai_items SET claimed_at = NULL WHERE job_id = $1 AND product_id = $2', [job.id, item.product_id])
    await pool.query('UPDATE photo_ai_jobs SET serper_calls = serper_calls + $2, gemini_calls = gemini_calls + $3, updated_at = now() WHERE id = $1', [job.id, calls.serper, calls.gemini])
  }
  return outcome
}

/** Крок черги (раз на хвилину від будильника бази). */
export async function runPhotoAiStep(deps: FindDeps & { now?: () => number } = {}): Promise<{ jobs: number; items: number; found: number; waiting?: string }> {
  const now = deps.now ?? Date.now
  const deadline = now() + QUEUE_RUN_MS
  const { rows } = await pool.query("SELECT * FROM photo_ai_jobs WHERE status = 'running' AND (retry_at IS NULL OR retry_at <= now()) ORDER BY created_at LIMIT 3")
  let items = 0, found = 0, waiting: string | undefined
  for (const job of rows as JobRow[]) {
    const [settings, keys] = await Promise.all([readSettings(job.tenant_id), readKeys(job.tenant_id)])
    if (settings.night_only && !isNight(new Date(now()))) { waiting = 'night'; continue }
    let running = true
    while (running && now() < deadline - QUEUE_ITEM_MS + 5_000) {
      const claimed = await claimItems(job.id, QUEUE_PARALLEL)
      if (!claimed.length) break
      const outcomes = await Promise.all(claimed.map(item => processItem(job, item, settings, keys, deps)))
      for (const outcome of outcomes) if (outcome.kind === 'done') { items += 1; found += outcome.found ? 1 : 0 }
      const stop = outcomes.find((outcome): outcome is Extract<ItemOutcome, { kind: 'stop' }> => outcome.kind === 'stop')
      if (stop) {
        await pool.query("UPDATE photo_ai_jobs SET status = 'stopped', stop_reason = $2, updated_at = now() WHERE id = $1 AND status = 'running'", [job.id, stop.reason])
        running = false
      } else if (outcomes.some(outcome => outcome.kind === 'later')) {
        const retries = job.retries + 1
        if (retries >= RETRY_LIMIT) await pool.query("UPDATE photo_ai_jobs SET status = 'stopped', stop_reason = 'gemini_busy', retries = $2, updated_at = now() WHERE id = $1 AND status = 'running'", [job.id, retries])
        else await pool.query("UPDATE photo_ai_jobs SET retries = $2, retry_at = now() + make_interval(mins => $3), updated_at = now() WHERE id = $1 AND status = 'running'",
          [job.id, retries, RETRY_MINUTES[Math.min(retries - 1, RETRY_MINUTES.length - 1)]])
        running = false
      } else {
        job.retries = 0
        running = (await pool.query('SELECT status FROM photo_ai_jobs WHERE id = $1', [job.id])).rows[0]?.status === 'running'
      }
    }
    const left = Number((await pool.query("SELECT count(*)::int AS n FROM photo_ai_items WHERE job_id = $1 AND state = 'pending'", [job.id])).rows[0]?.n) || 0
    if (!left) await pool.query("UPDATE photo_ai_jobs SET status = 'done', finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'running'", [job.id])
  }
  return { jobs: rows.length, items, found, ...(waiting ? { waiting } : {}) }
}
