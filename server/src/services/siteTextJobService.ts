import { z } from 'zod'
import { pool } from '../db/pg.js'
import { logger } from '../lib/logger.js'
import { AppError } from '../middleware/errorHandler.js'
import { ClaudeClient, isClaudeModel, type ClaudeUsage } from './aiClaude.js'
import { checkLine, checkPrompt, parseCheckReply } from './siteTextCheck.js'
import { AiExecutionBudget } from './aiExecutionBudget.js'
import { usageCostUsd } from './aiJobService.js'
import { guardProductText, parseTextReply, productLine, textJobPrompt, type ProductFacts, type TextFields } from './siteTextGuard.js'

/**
 * Масова робота над текстами товарів для сайту (26.11.2026). Хід:
 *   1) «sample» — сервер пише 10 зразків і НІЧОГО не записує на сайт → «sample_ready»;
 *   2) власник один раз каже «годиться» (або дає побажання до стилю — зразки переписуються);
 *   3) «running» — сервер сам проходить усі товари: текст → автоперевірка (siteTextGuard) → чистий одразу на сайт,
 *      сумнівний — «на перевірку» з причиною; товар, де опис уже є, не чіпається (якщо власник не просив переписати);
 *   4) «повернути як було» — на сайт повертається те, що стояло до запису (old_fields).
 * Запис — тим самим шлюзом сайту з журналом аудиту, від імені того, хто запустив.
 */
export const TEXT_CHUNK = 4, TEXT_PARALLEL = 6, TEXT_RUN_MS = 50_000, TEXT_SAMPLE = 10, TEXT_STALE_MS = 5 * 60_000, TEXT_ATTEMPTS = 3
export const createTextJobSchema = z.object({
  // 27.11.2026 («Доповнення 5» контракту сайту): site_missing — товари сайту без заголовка чи опису для Google; список дає сайт.
  scope: z.enum(['site_missing', 'in_stock', 'all']).default('site_missing'),
  overwrite: z.boolean().default(false),
  style_note: z.string().trim().max(2000).optional(),
})
export const textJobActionSchema = z.object({
  action: z.enum(['approve_sample', 'redo_sample', 'pause', 'resume', 'cancel', 'revert', 'retry_failed', 'write_review', 'reject_review']),
  style_note: z.string().trim().max(2000).optional(),
  product_ids: z.array(z.string().uuid()).max(500).optional(),
})
type JobRow = { id: string; tenant_id: string; created_by: string; scope: string; overwrite: boolean; style_note: string | null; status: string; total: number; processed: number; written: number; review: number; skipped: number; failed: number; cost_usd: string; last_error: string | null; created_at: string; updated_at: string }
type Item = { product_id: string; seq: number; name: string; state: string; new_fields: TextFields | null; old_fields: Record<string, unknown> | null }
export type TextGateway = (user: { id: string; tenant_id: string }, action: string, params: Record<string, unknown>) => Promise<unknown>
export type TextModel = { complete: (budget: AiExecutionBudget, input: { system: string; text: string; maxTokens?: number; effort?: 'low' | 'medium' | 'high' }) => Promise<ClaudeUsage & { text: string; truncated: boolean }> }

const OPEN = ['sample', 'sample_ready', 'running', 'paused', 'reverting']
function publicJob(row: JobRow) {
  return { id: row.id, scope: row.scope, overwrite: row.overwrite, style_note: row.style_note, status: row.status, total: row.total, processed: row.processed, written: row.written,
    review: row.review, skipped: row.skipped, failed: row.failed, cost_usd: Number(row.cost_usd), last_error: row.last_error, created_at: row.created_at, updated_at: row.updated_at,
    progress: row.total ? Math.min(100, Math.round(row.processed / row.total * 100)) : 0 }
}

/** Товари сайту, яким бракує заголовка/опису для Google чи тексту опису (seo.products.missing), без повторів. */
export async function readSiteMissing(user: { id: string; tenant_id: string }, gateway: TextGateway, maxPages = 300): Promise<Array<{ product_id: string; name: string; old: Record<string, unknown> }>> {
  const found = new Map<string, { product_id: string; name: string; old: Record<string, unknown> }>()
  for (const field of [undefined, 'description'] as const) {
    for (let page = 0; page < maxPages; page++) {
      const rows = await gateway(user, 'seo.products.missing', { limit: 100, offset: page * 100, ...(field ? { field } : {}) })
      if (!Array.isArray(rows) || !rows.length) break
      for (const row of rows as Array<Record<string, unknown>>) {
        const id = String(row?.program_product_id ?? '')
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || found.has(id)) continue
        found.set(id, { product_id: id, name: String(row.title ?? '').slice(0, 400) || 'Товар', old: { seo_title: String(row.seo_title ?? ''), seo_description: String(row.seo_description ?? ''), has_description: Boolean(row.has_description), from_site_list: true } })
      }
      if (rows.length < 100) break
    }
  }
  return [...found.values()]
}

export async function createTextJob(tenantId: string, userId: string, input: z.infer<typeof createTextJobSchema>, gateway?: TextGateway) {
  // Список із сайту читаємо до транзакції: це кілька запитів до шлюзу, базу на цей час не тримаємо.
  const missing = input.scope === 'site_missing'
    ? await readSiteMissing({ id: userId, tenant_id: tenantId }, gateway ?? (async (user, action, params) => (await import('./siteGatewayService.js')).siteGatewayAction(user, action, params)))
    : null
  if (missing && !missing.length) throw new AppError('VALIDATION_ERROR', 'Сайт каже, що в усіх товарів уже є заголовок і опис для Google. Якщо хочете переписати — виберіть «Наші товари в наявності» й «переписати».', 422)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const open = await client.query('SELECT id FROM site_text_jobs WHERE tenant_id = $1 AND status = ANY($2) LIMIT 1', [tenantId, OPEN])
    if (open.rows.length) throw new AppError('CONFLICT', 'Одна робота над текстами вже йде. Дочекайтесь її або скасуйте.', 409)
    const { rows } = await client.query('INSERT INTO site_text_jobs (tenant_id, created_by, scope, overwrite, style_note) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [tenantId, userId, input.scope, input.overwrite, input.style_note || null])
    // Спершу товари в наявності й дорожчі: вони дають продажі, тож їхні сторінки мають зʼявитись у Google першими.
    const filled = missing ? await client.query(
      `INSERT INTO site_text_items (job_id, product_id, seq, name, old_fields)
       SELECT $1, p.id, row_number() OVER (ORDER BY (p.qty_on_hand > 0) DESC, p.retail_price DESC, p.id), p.name, x.old
         FROM jsonb_to_recordset($3::jsonb) AS x(product_id uuid, old jsonb)
         JOIN products p ON p.id = x.product_id AND p.tenant_id = $2 AND p.deleted_at IS NULL`, [rows[0].id, tenantId, JSON.stringify(missing.map(row => ({ product_id: row.product_id, old: row.old })))])
    : await client.query(
      `INSERT INTO site_text_items (job_id, product_id, seq, name)
       SELECT $1, p.id, row_number() OVER (ORDER BY (p.qty_on_hand > 0) DESC, p.retail_price DESC, p.id), p.name
         FROM products p WHERE p.tenant_id = $2 AND p.deleted_at IS NULL AND p.is_active AND NOT COALESCE(p.is_service, false)
          AND char_length(trim(p.name)) >= 4 AND ($3 = 'all' OR p.qty_on_hand > 0)`, [rows[0].id, tenantId, input.scope])
    if (!filled.rowCount) throw new AppError('VALIDATION_ERROR', 'Немає товарів для цієї роботи.', 422)
    const job = await client.query('UPDATE site_text_jobs SET total = $2 WHERE id = $1 RETURNING *', [rows[0].id, filled.rowCount])
    await client.query('COMMIT')
    return publicJob(job.rows[0])
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error } finally { client.release() }
}

export async function listTextJobs(tenantId: string) {
  const { rows } = await pool.query('SELECT * FROM site_text_jobs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 5', [tenantId])
  return rows.map(publicJob)
}
async function job(tenantId: string, id: string): Promise<JobRow> {
  const { rows } = await pool.query('SELECT * FROM site_text_jobs WHERE tenant_id = $1 AND id = $2', [tenantId, id])
  if (!rows.length) throw new AppError('NOT_FOUND', 'Роботу не знайдено', 404)
  return rows[0]
}
export async function listTextItems(tenantId: string, id: string, state: string, page: number, perPage = 50) {
  await job(tenantId, id)
  const { rows } = await pool.query('SELECT product_id::text AS product_id, name, state, new_fields, note FROM site_text_items WHERE job_id = $1 AND state = $2 ORDER BY seq LIMIT $3 OFFSET $4',
    [id, state, perPage, (Math.max(1, page) - 1) * perPage])
  return { items: rows }
}

export async function textJobAction(tenantId: string, id: string, input: z.infer<typeof textJobActionSchema>) {
  const current = await job(tenantId, id)
  const refuse = (text: string) => { throw new AppError('CONFLICT', text, 409) }
  const set = (status: string, extra = '') => pool.query(`UPDATE site_text_jobs SET status = $2, last_error = NULL, updated_at = now() ${extra} WHERE id = $1`, [id, status])
  const ids = input.product_ids?.length ? input.product_ids : null
  switch (input.action) {
    case 'approve_sample':
      if (current.status !== 'sample_ready') refuse('Зразки ще не готові.')
      await pool.query("UPDATE site_text_items SET state = 'towrite', updated_at = now() WHERE job_id = $1 AND state = 'sample'", [id])
      await set('running'); break
    case 'redo_sample':
      if (!['sample_ready', 'sample'].includes(current.status)) refuse('Зразки можна переписати лише до запуску.')
      await pool.query("UPDATE site_text_items SET state = 'pending', new_fields = NULL, note = NULL, attempts = 0, claimed_at = NULL WHERE job_id = $1 AND state IN ('sample', 'review', 'working')", [id])
      await pool.query('UPDATE site_text_jobs SET style_note = $2 WHERE id = $1', [id, input.style_note || current.style_note])
      await set('sample'); break
    case 'pause': if (current.status !== 'running') refuse('Робота не йде.'); await set('paused'); break
    case 'resume': if (current.status !== 'paused') refuse('Робота не на паузі.'); await set('running'); break
    case 'cancel': if (!OPEN.includes(current.status)) refuse('Роботу вже завершено.'); await set('cancelled'); break
    case 'revert':
      if (!['done', 'cancelled', 'paused'].includes(current.status)) refuse('Спершу зупиніть роботу.')
      await set('reverting'); break
    case 'retry_failed':
      await pool.query("UPDATE site_text_items SET state = 'pending', attempts = 0, note = NULL WHERE job_id = $1 AND state = 'failed'", [id])
      if (['done', 'paused'].includes(current.status)) await set('running'); break
    case 'write_review':
      await pool.query("UPDATE site_text_items SET state = 'towrite', updated_at = now() WHERE job_id = $1 AND state = 'review' AND ($2::uuid[] IS NULL OR product_id = ANY($2))", [id, ids])
      if (current.status === 'done') await set('running'); break
    case 'reject_review':
      await pool.query("UPDATE site_text_items SET state = 'rejected', updated_at = now() WHERE job_id = $1 AND state = 'review' AND ($2::uuid[] IS NULL OR product_id = ANY($2))", [id, ids]); break
  }
  await refreshCounters(id)
  return publicJob(await job(tenantId, id))
}

async function refreshCounters(jobId: string): Promise<void> {
  await pool.query(
    `UPDATE site_text_jobs j SET processed = c.processed, written = c.written, review = c.review, skipped = c.skipped, failed = c.failed, updated_at = now()
       FROM (SELECT count(*) FILTER (WHERE state NOT IN ('pending', 'working'))::int AS processed, count(*) FILTER (WHERE state = 'written')::int AS written,
                    count(*) FILTER (WHERE state = 'review')::int AS review, count(*) FILTER (WHERE state = 'skipped')::int AS skipped,
                    count(*) FILTER (WHERE state = 'failed')::int AS failed FROM site_text_items WHERE job_id = $1) c WHERE j.id = $1`, [jobId])
}

async function claim(jobId: string, state: 'pending' | 'towrite' | 'written', limit: number): Promise<Item[]> {
  const { rows } = await pool.query(
    `UPDATE site_text_items SET claimed_at = now(), attempts = attempts + 1 ${state === 'pending' ? ", state = 'working'" : ''}
      WHERE (job_id, product_id) IN (
        SELECT job_id, product_id FROM site_text_items
         WHERE job_id = $1 AND (${state === 'pending' ? "state = 'pending' OR (state = 'working' AND claimed_at < now() - make_interval(secs => $3))" : `state = '${state}' AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => $3))`})
         ORDER BY seq LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING product_id::text AS product_id, seq, name, state, new_fields, old_fields`, [jobId, limit, TEXT_STALE_MS / 1000])
  return rows.sort((a: Item, b: Item) => a.seq - b.seq)
}
const finish = (jobId: string, productId: string, state: string, note: string | null, fields?: { old?: unknown; next?: unknown }) => pool.query(
  `UPDATE site_text_items SET state = $3, note = $4, claimed_at = NULL, updated_at = now(),
     old_fields = COALESCE($5::jsonb, old_fields), new_fields = COALESCE($6::jsonb, new_fields) WHERE job_id = $1 AND product_id = $2`,
  [jobId, productId, state, note?.slice(0, 500) ?? null, fields?.old === undefined ? null : JSON.stringify(fields.old), fields?.next === undefined ? null : JSON.stringify(fields.next)])

async function loadFacts(tenantId: string, ids: string[]): Promise<Map<string, ProductFacts>> {
  const { rows } = await pool.query(
    `SELECT p.id::text AS id, p.name, p.sku, p.unit, p.oem_number, p.specs, b.name AS brand, c.name AS category,
            (SELECT array_agg(x.cross ORDER BY x.cross) FROM (SELECT COALESCE(n.brand || ' ', '') || n.number AS cross FROM product_cross_numbers n WHERE n.product_id = p.id AND n.tenant_id = p.tenant_id AND n.deleted_at IS NULL ORDER BY n.is_verified DESC, n.number LIMIT 12) x) AS crosses
       FROM products p LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id LEFT JOIN categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.id = ANY($2::uuid[])`, [tenantId, ids])
  return new Map(rows.map((row: any) => [row.id, { name: String(row.name), sku: row.sku && !/^AUTO-/i.test(row.sku) ? String(row.sku) : null, brand: row.brand, category: row.category,
    unit: row.unit, oem: row.oem_number, specs: row.specs, crosses: Array.isArray(row.crosses) ? row.crosses : [] }]))
}

/** Що стояло на сайті до запису — для «повернути як було». has_description: опис на сайті вже був (його не переписуємо без прохання). */
function siteFields(current: Record<string, unknown>, overwrite: boolean) {
  const has = current.from_site_list ? Boolean(current.has_description) : String(current.description ?? '').trim().length >= 80
  return { description: current.from_site_list ? '' : String(current.description ?? ''), seo_title: String(current.seo_title ?? ''), seo_description: String(current.seo_description ?? ''),
    seo_keywords: String(current.seo_keywords ?? ''), has_description: has, write_description: overwrite || !has }
}
class NotOnSite extends Error {}
/** Запис на сайт пачковою дією seo.products.set (27.11.2026): лише поля для Google і, за потреби, опис; решта товару не чіпається. */
async function writeToSite(user: { id: string; tenant_id: string }, gateway: TextGateway, productId: string, fields: TextFields, withDescription: boolean) {
  const answer = (await gateway(user, 'seo.products.set', { items: [{ program_product_id: productId, seo_title: fields.seo_title, seo_description: fields.seo_description,
    seo_keywords: fields.seo_keywords ?? '', ...(withDescription ? { description: fields.description } : {}) }] }) ?? {}) as { saved?: unknown; not_on_site?: unknown }
  if ((Array.isArray(answer.not_on_site) && answer.not_on_site.map(String).includes(productId)) || answer.saved === 0) throw new NotOnSite()
}

/** Одна пачка: що стоїть на сайті → кому текст потрібен → модель → автоперевірка → запис (або «на перевірку»). */
export async function processTextChunk(row: Pick<JobRow, 'id' | 'tenant_id' | 'created_by' | 'overwrite' | 'style_note'>, items: Item[], sample: boolean,
  model: TextModel, gateway: TextGateway, budget: AiExecutionBudget, checker?: TextModel): Promise<ClaudeUsage | null> {
  const user = { id: row.created_by, tenant_id: row.tenant_id }
  const facts = await loadFacts(row.tenant_id, items.map(item => item.product_id))
  const work: Array<{ item: Item; facts: ProductFacts; current: ReturnType<typeof siteFields> }> = []
  await Promise.all(items.map(async item => {
    const data = facts.get(item.product_id)
    if (!data) { await finish(row.id, item.product_id, 'skipped', 'товар видалено'); return }
    try {
      // Товар зі списку сайту (seo.products.missing) уже несе те, що стоїть на сайті; інакше питаємо сайт.
      const known = item.old_fields?.from_site_list ? item.old_fields : (await gateway(user, 'products.site_fields.get', { program_product_id: item.product_id }) ?? {}) as Record<string, unknown>
      const current = siteFields(known, row.overwrite)
      if (!row.overwrite && current.has_description && current.seo_title.trim() && current.seo_description.trim()) { await finish(row.id, item.product_id, 'skipped', 'на сайті вже все заповнено', { old: current }); return }
      work.push({ item, facts: data, current })
    } catch { await retryOrFail(row.id, item, 'сайт не відповів') }
  }))
  if (!work.length) return null
  let answer: (ClaudeUsage & { text: string; truncated: boolean }) | null = null
  try {
    answer = await model.complete(budget, { system: textJobPrompt(row.style_note), text: work.map(entry => productLine(entry.item.seq, entry.facts)).join('\n'), maxTokens: 8000, effort: 'medium' })
  } catch (error) {
    await pool.query("UPDATE site_text_items SET state = 'pending', claimed_at = NULL WHERE job_id = $1 AND product_id = ANY($2::uuid[]) AND state = 'working'", [row.id, work.map(entry => entry.item.product_id)])
    throw error
  }
  const replies = parseTextReply(answer.text, new Set(work.map(entry => entry.item.seq)))
  // Друга перевірка окремим запитом: модель читає готові тексти поруч із даними товару й шукає те, чого автоперевірка за правилами не бачить:
  // вигадану сумісність, властивості, переплутаний вид товару, російські слова. Не відповіла — тексти не блокуємо.
  const total: ClaudeUsage = { promptTokens: answer.promptTokens, completionTokens: answer.completionTokens, costAdjustUsd: answer.costAdjustUsd ?? 0 }
  let doubts = new Map<number, string>()
  const clean = work.filter(entry => { const fields = replies.get(entry.item.seq); return fields && !guardProductText(entry.facts, fields).length })
  if (checker && clean.length) {
    try {
      const verdict = await checker.complete(budget, { system: checkPrompt(), text: clean.map(entry => checkLine(entry.item.seq, entry.facts, replies.get(entry.item.seq)!)).join('\n\n'), maxTokens: 3000, effort: 'medium' })
      total.promptTokens += verdict.promptTokens; total.completionTokens += verdict.completionTokens; total.costAdjustUsd = (total.costAdjustUsd ?? 0) + (verdict.costAdjustUsd ?? 0)
      doubts = parseCheckReply(verdict.text, new Set(clean.map(entry => entry.item.seq)))
    } catch (error) { logger.warn({ job: row.id, code: (error as AppError)?.code }, '[site-texts] second check skipped') }
  }
  await Promise.all(work.map(async ({ item, facts: data, current }) => {
    const fields = replies.get(item.seq)
    if (!fields) { await retryOrFail(row.id, item, 'помічник не дав тексту'); return }
    const problems = guardProductText(data, fields)
    if (problems.length) { await finish(row.id, item.product_id, 'review', problems.join('; '), { old: current, next: fields }); return }
    const doubt = doubts.get(item.seq)
    if (doubt) { await finish(row.id, item.product_id, 'review', 'друга перевірка: ' + doubt, { old: current, next: fields }); return }
    if (sample) { await finish(row.id, item.product_id, 'sample', null, { old: current, next: fields }); return }
    try { await writeToSite(user, gateway, item.product_id, fields, current.write_description); await finish(row.id, item.product_id, 'written', null, { old: current, next: fields }) }
    catch (error) {
      if (error instanceof NotOnSite) await finish(row.id, item.product_id, 'skipped', 'цього товару немає на сайті', { old: current, next: fields })
      else await finish(row.id, item.product_id, 'towrite', 'сайт не прийняв — повторимо', { old: current, next: fields })
    }
  }))
  return total
}
async function retryOrFail(jobId: string, item: Item & { attempts?: number }, note: string) {
  const { rows } = await pool.query('SELECT attempts FROM site_text_items WHERE job_id = $1 AND product_id = $2', [jobId, item.product_id])
  await finish(jobId, item.product_id, (rows[0]?.attempts ?? 0) >= TEXT_ATTEMPTS ? 'failed' : 'pending', note)
}

/** Пробудження від планувальника (те саме, що будить фонові задачі помічника). Немає роботи — повертається одразу. */
export async function runSiteTextStep(deps: { model?: (apiKey: string, model: string) => TextModel; gateway?: TextGateway; now?: () => number } = {}): Promise<{ jobs: number; chunks: number; errors: number }> {
  const now = deps.now ?? Date.now, deadline = now() + TEXT_RUN_MS
  const { rows: jobs } = await pool.query("SELECT * FROM site_text_jobs WHERE status IN ('sample', 'running', 'reverting') ORDER BY updated_at LIMIT 2")
  if (!jobs.length) return { jobs: 0, chunks: 0, errors: 0 }
  const gateway: TextGateway = deps.gateway ?? (async (user, action, params) => (await import('./siteGatewayService.js')).siteGatewayAction(user, action, params))
  const { getAiConfig, recordAiUsage } = await import('./aiService.js')
  let chunks = 0, errors = 0
  for (const row of jobs as JobRow[]) {
    const user = { id: row.created_by, tenant_id: row.tenant_id }
    const alive = async () => (await pool.query('SELECT status FROM site_text_jobs WHERE id = $1', [row.id])).rows[0]?.status === row.status
    if (row.status === 'reverting') {
      // Повертаємо на сайт те, що стояло до запису; модель не потрібна.
      while (now() < deadline - 15_000 && await alive()) {
        const items = await claim(row.id, 'written', 8)
        if (!items.length) { await pool.query("UPDATE site_text_jobs SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'reverting'", [row.id]); break }
        await Promise.all(items.map(async item => {
          const old = (item.old_fields ?? {}) as Record<string, unknown>
          try {
            await writeToSite(user, gateway, item.product_id, { description: String(old.description ?? ''), seo_title: String(old.seo_title ?? ''), seo_description: String(old.seo_description ?? ''), seo_keywords: String(old.seo_keywords ?? '') }, old.write_description !== false)
            await finish(row.id, item.product_id, 'reverted', null)
          }
          catch { errors += 1; await pool.query('UPDATE site_text_items SET claimed_at = now() WHERE job_id = $1 AND product_id = $2', [row.id, item.product_id]) }
        }))
        await refreshCounters(row.id)
      }
      continue
    }
    const config = await getAiConfig(row.tenant_id).catch(() => null)
    if (!config?.enabled || !config.apiKey) {
      await pool.query("UPDATE site_text_jobs SET status = 'paused', last_error = $2, updated_at = now() WHERE id = $1", [row.id, 'Помічник вимкнений або немає ключа Anthropic (Налаштування → ШІ).'])
      continue
    }
    const model = deps.model ? deps.model(config.apiKey, config.model) : new ClaudeClient(config.apiKey, isClaudeModel(config.model) ? config.model : 'claude-sonnet-5-5')
    // Рішення власника 26.11.2026: «лишаємо Sonnet» — другу перевірку робить та сама основна модель окремим запитом.
    const checker: TextModel = model
    const sample = row.status === 'sample'
    while (now() < deadline - 25_000 && await alive()) {
      // Спершу — уже погоджені тексти (зразки після «годиться», відмічені «на перевірку»): їм модель не потрібна.
      const ready = sample ? [] : await claim(row.id, 'towrite', 12)
      await Promise.all(ready.map(async item => {
        try { await writeToSite(user, gateway, item.product_id, item.new_fields as TextFields, (item.old_fields as { write_description?: boolean } | null)?.write_description !== false); await finish(row.id, item.product_id, 'written', null) }
        catch (error) { if (error instanceof NotOnSite) await finish(row.id, item.product_id, 'skipped', 'цього товару немає на сайті'); else errors += 1 }
      }))
      const sampled = sample ? (await pool.query("SELECT count(*)::int AS n FROM site_text_items WHERE job_id = $1 AND state = 'sample'", [row.id])).rows[0].n : 0
      if (sample && sampled >= TEXT_SAMPLE) { await pool.query("UPDATE site_text_jobs SET status = 'sample_ready', updated_at = now() WHERE id = $1 AND status = 'sample'", [row.id]); break }
      const batch: Item[][] = []
      for (let i = 0; i < (sample ? Math.ceil((TEXT_SAMPLE - sampled) / TEXT_CHUNK) : TEXT_PARALLEL); i++) {
        const items = await claim(row.id, 'pending', TEXT_CHUNK)
        if (!items.length) break
        batch.push(items)
      }
      if (!batch.length && !ready.length) {
        const left = (await pool.query("SELECT count(*)::int AS n FROM site_text_items WHERE job_id = $1 AND state IN ('pending', 'working', 'towrite')", [row.id])).rows[0].n
        if (!left) await pool.query(`UPDATE site_text_jobs SET status = $2, updated_at = now() WHERE id = $1 AND status = $3`, [row.id, sample ? 'sample_ready' : 'done', row.status])
        break
      }
      const budget = new AiExecutionBudget(Math.max(5_000, deadline - now()))
      const results = await Promise.allSettled(batch.map(items => processTextChunk(row, items, sample, model, gateway, budget, checker)))
      budget.dispose()
      let cost = 0, prompt = 0, completion = 0, adjust = 0, lastError: string | null = null
      for (const result of results) {
        if (result.status === 'fulfilled') { chunks += 1; if (result.value) { cost += usageCostUsd(result.value); prompt += result.value.promptTokens; completion += result.value.completionTokens; adjust += result.value.costAdjustUsd ?? 0 } }
        else { errors += 1; lastError = result.reason instanceof Error ? result.reason.message : 'Помилка ШІ'; logger.warn({ job: row.id, code: (result.reason as AppError)?.code }, '[site-texts] chunk failed') }
      }
      if (prompt || completion) await recordAiUsage(row.tenant_id, row.created_by, config.model, prompt, completion, undefined, adjust).catch(() => undefined)
      await pool.query('UPDATE site_text_jobs SET cost_usd = cost_usd + $2, last_error = $3, updated_at = now() WHERE id = $1', [row.id, cost, lastError])
      await refreshCounters(row.id)
      if (results.some(result => result.status === 'rejected' && ['AI_QUOTA_EXCEEDED', 'AI_KEY_INVALID'].includes((result.reason as AppError)?.code))) {
        await pool.query("UPDATE site_text_jobs SET status = 'paused', updated_at = now() WHERE id = $1 AND status IN ('running', 'sample')", [row.id]); break
      }
    }
    await refreshCounters(row.id)
  }
  return { jobs: jobs.length, chunks, errors }
}
