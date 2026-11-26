import { z } from 'zod'
import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { logger } from '../lib/logger.js'
import { AiExecutionBudget } from './aiExecutionBudget.js'
import { ClaudeClient, CLAUDE_PRICES, isClaudeModel, type ClaudeUsage } from './aiClaude.js'

/**
 * 26.11.2026, слово власника: «помічник бере по 200 товарів за раз і робить це дуже довго; товарів у мене дуже багато,
 * а з API постачальників — мільйони; хай працює на сервері у фоні: запустив на будь-якому пристрої — і він працює».
 *
 * Фонова задача — це черга в базі (ai_jobs + ai_job_items), а не розмова: планувальник бази щохвилини будить сервер,
 * сервер бере кілька пачок одночасно, модель відповідає коротко (номер + нова назва), а програма перевіряє кожну назву
 * сама. Нічого не записується в картки без людини: готові пропозиції власник переглядає й застосовує кнопкою.
 * Наші товари застосовуються через головний ПК (той самий захищений шлях, що й пропозиції чату), товари постачальників —
 * у хмарі в окреме поле «наша назва» (прайс постачальника кожні 3 год перезаписує свою назву, а нашу — ні).
 */

/** Товарів в одному запиті до моделі. Більше — довша відповідь і більший ризик обриву; менше — дорожчі повтори правил. */
export const JOB_CHUNK = 80
/** Скільки запитів до моделі одночасно в одному пробудженні сервера. */
export const JOB_PARALLEL = 4
/** Пробудження щохвилини; одне пробудження працює не довше за цей час, щоб наступне не накладалось. */
export const JOB_RUN_MS = 50_000
/** Пачка, яку взяли й не повернули (сервер перезапустився), повертається в чергу через стільки. */
export const JOB_STALE_CLAIM_MS = 10 * 60_000
/** Найбільша задача: мільйон рядків — черга в базі це витримує. */
export const JOB_MAX_ITEMS = 1_000_000

export type JobTarget = 'products' | 'supplier_offers'
export type JobTask = 'cleanup' | 'translate' | 'cleanup_translate'
export type JobFilter = 'messy_names' | 'russian_names' | 'all'

export const createJobSchema = z.object({
  target: z.enum(['products', 'supplier_offers']),
  task: z.enum(['cleanup', 'translate', 'cleanup_translate']),
  filter: z.enum(['messy_names', 'russian_names', 'all']).default('messy_names'),
  connection_id: z.string().uuid().optional(),
})

/** Ті самі ознаки, що й у list_products_page чату: брудна назва та російська мова. */
export const MESSY_NAME_RE = '.{90}|знайдено за|[|>]|[[:space:]]{2}|[0-9]{2,5} [0-9]{2} [а-яіїє]'
export const RUSSIAN_NAME_RE = '[ёыэъ]|(ый|ое|ая|ние|ской|ского)\\y'

const TASK_TITLE: Record<JobTask, string> = {
  cleanup: 'Порядок у назвах', translate: 'Переклад назв українською', cleanup_translate: 'Порядок у назвах і переклад',
}
const FILTER_TITLE: Record<JobFilter, string> = { messy_names: 'лише «брудні» назви', russian_names: 'лише російські назви', all: 'усі назви' }

/** Правила назви — ті самі, що в чаті помічника (НАВЕДЕННЯ ПОРЯДКУ В НАЗВАХ). */
export const NAME_RULES = [
  'Нова назва: тип товару → для чого/на яке авто (коротко) → бренд → суттєві характеристики (вʼязкість, обʼєм, розмір, сторона, кількість у комплекті) → артикул у кінці.',
  'ПРИБИРАЙ: службові коди й числа з прайсів постачальника («VL», «KV», «5 13348 40», «372 87», «4>132»), повтор бренду, «Знайдено за: …», повтори слів, обірвані хвости, зайві дужки й пробіли, роки випуску й довгі переліки модифікацій авто, якщо назва й без них однозначна.',
  'ЛИШАЙ як є: бренд, артикул/каталожний номер, обʼєм і розміри з одиницями, вʼязкість і допуски (10W40, API SL/CF), сторону, модель авто.',
  'Нічого НЕ вигадуй: жодного числа чи слова-характеристики, якого не було в старій назві.',
  'Приклад: «VALEO VL 700431 5 13348 40 Дросельна заслонка з електроприводом OPEL VIVARO A (X83) - 2.0 CDTI (F7) (2001.08 - 2014.07» → «Дросельна заслонка з електроприводом OPEL VIVARO A VALEO 700431», артикул 700431.',
].join('\n')

export function jobSystemPrompt(task: JobTask): string {
  const what = task === 'translate'
    ? 'Перекладаєш назви автотоварів українською. Бренди, артикули, коди, розміри, моделі авто й латинські позначення НЕ перекладай і не змінюй. Цифр не прибирай і не додавай. Назву, вже написану українською, не змінюй.'
    : task === 'cleanup'
      ? 'Наводиш порядок у назвах автотоварів. Мову назви не змінюй.\n' + NAME_RULES
      : 'Наводиш порядок у назвах автотоварів і пишеш їх українською (бренди, артикули, коди, моделі авто — без перекладу).\n' + NAME_RULES
  return [
    'Ти — кладівник магазину автозапчастин.', what,
    'Вхід — рядки «№<номер>\\t<артикул або ->\\t<стара назва>».',
    'Якщо артикул «-» або починається з AUTO-, а в назві є однозначний каталожний номер — поверни його в полі sku (і лиши в кінці назви). Якщо неясно, який код є артикулом, — sku не заповнюй.',
    'Назву, з якої не зрозуміло, що це за товар, або яку не треба міняти — пропусти (не включай у відповідь).',
    'Поверни ЛИШЕ JSON без Markdown: {"items":[{"n":<номер>,"name":"<нова назва>","sku":"<артикул або порожньо>"}]}.',
  ].join('\n')
}

const compact = (value: string) => value.toUpperCase().replace(/[^A-ZА-ЯІЇЄҐ0-9]/g, '')
const digitTokens = (value: string) => [...new Set((value.match(/[\p{L}\p{N}][\p{L}\p{N}/.>-]*[\p{L}\p{N}]|\p{N}/gu) ?? []).filter(token => /\d/.test(token)))]
const realSku = (sku: string | null | undefined) => Boolean(sku && sku.trim() && !/^AUTO-/i.test(sku.trim()))

export type Verdict = { state: 'proposed' | 'suspicious' | 'unchanged'; name: string | null; sku: string | null; note: string | null }

/**
 * Перевірка кожної назви програмою, а не довіра моделі. Підозріле не відкидається, а йде власнику окремим списком.
 * — у новій назві не може зʼявитися код чи число, якого не було в старій (вигадка);
 * — переклад не прибирає жодного коду чи числа; «порядок» може прибрати (видно, що саме);
 * — справжній артикул, який був у назві, лишається в назві (за ним шукають);
 * — артикул з назви — лише замість порожнього чи службового AUTO-… і лише той, що є в старій назві.
 */
export function judgeName(task: JobTask, oldName: string, sku: string | null, rawName: unknown, rawSku: unknown): Verdict {
  const name = typeof rawName === 'string' ? rawName.replace(/\s+/g, ' ').trim() : ''
  if (!name || name === oldName.replace(/\s+/g, ' ').trim()) return { state: 'unchanged', name: null, sku: null, note: null }
  const notes: string[] = []
  let suspicious = false
  if (name.length > 300) { suspicious = true; notes.push('задовга назва') }
  const oldCompact = compact(oldName)
  const invented = digitTokens(name).filter(token => !oldCompact.includes(compact(token)))
  if (invented.length) { suspicious = true; notes.push('зʼявилось: ' + invented.slice(0, 5).join(', ')) }
  const newCompact = compact(name)
  const dropped = digitTokens(oldName).filter(token => !newCompact.includes(compact(token)))
  if (dropped.length) {
    if (task === 'translate') { suspicious = true; notes.push('зникло: ' + dropped.slice(0, 5).join(', ')) }
    else notes.push('прибрано: ' + dropped.slice(0, 8).join(' · '))
  }
  if (realSku(sku) && oldCompact.includes(compact(sku!)) && !newCompact.includes(compact(sku!))) { suspicious = true; notes.push('зник артикул ' + sku) }
  let newSku: string | null = typeof rawSku === 'string' ? rawSku.trim() : ''
  if (!newSku || realSku(sku) || !oldCompact.includes(compact(newSku)) || newSku.length > 60) newSku = null
  return { state: suspicious ? 'suspicious' : 'proposed', name, sku: newSku, note: notes.join('; ').slice(0, 500) || null }
}

/** Розбір відповіді моделі: JSON, можливо обгорнутий у ```; номери лише з поданої пачки. */
export function parseJobReply(text: string, allowed: ReadonlySet<number>): Map<number, { name: unknown; sku: unknown }> {
  const body = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const start = body.indexOf('{'), end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new AppError('AI_INVALID_RESPONSE', 'ШІ повернув не JSON', 422)
  const parsed = JSON.parse(body.slice(start, end + 1)) as { items?: unknown }
  const out = new Map<number, { name: unknown; sku: unknown }>()
  for (const row of Array.isArray(parsed.items) ? parsed.items : []) {
    const n = Number((row as { n?: unknown })?.n)
    if (!Number.isInteger(n) || !allowed.has(n) || out.has(n)) continue
    out.set(n, { name: (row as { name?: unknown }).name, sku: (row as { sku?: unknown }).sku })
  }
  return out
}

export function usageCostUsd(usage: ClaudeUsage): number {
  return usage.promptTokens * CLAUDE_PRICES.input / 1_000_000 + usage.completionTokens * 10 / 1_000_000 + (usage.costAdjustUsd ?? 0)
}

/**
 * Оцінка до запуску: ~40 вхідних і ~35 вихідних токенів на товар (правила кешуються), 4 пачки по 80 щохвилини.
 * Це орієнтир; фактичні витрати й швидкість видно в задачі під час роботи.
 */
export function estimateJob(total: number): { cost_usd: number; minutes: number } {
  const cost = total * (40 * CLAUDE_PRICES.input + 35 * 10) / 1_000_000
  return { cost_usd: Number(cost.toFixed(2)), minutes: Math.max(1, Math.ceil(total / (JOB_CHUNK * JOB_PARALLEL))) }
}

type JobRow = { id: string; tenant_id: string; created_by: string | null; target: JobTarget; task: JobTask; filter: JobFilter; connection_id: string | null; title: string; status: string
  total: number; processed: number; changed: number; suspicious: number; applied: number; cost_usd: string | number; started_at: string | null; last_error: string | null; created_at: string; updated_at: string }

function publicJob(row: JobRow) {
  const total = Number(row.total) || 0, processed = Number(row.processed) || 0
  const elapsed = row.started_at ? Date.now() - new Date(row.started_at).getTime() : 0
  const eta = row.status === 'running' && processed > 0 && elapsed > 0 ? Math.round(elapsed / processed * Math.max(0, total - processed)) : null
  return {
    id: row.id, target: row.target, task: row.task, filter: row.filter, connection_id: row.connection_id, title: row.title, status: row.status,
    total, processed, changed: Number(row.changed) || 0, suspicious: Number(row.suspicious) || 0, applied: Number(row.applied) || 0,
    cost_usd: Number(row.cost_usd) || 0, last_error: row.last_error, created_at: row.created_at, updated_at: row.updated_at,
    estimate: estimateJob(Math.max(0, total - processed)),
    progress: { fraction: total ? Math.min(1, processed / total) : null, eta_ms: eta, loading: row.status === 'running', next_at: null },
  }
}
export type PublicJob = ReturnType<typeof publicJob>

export async function createJob(tenantId: string, userId: string, input: z.infer<typeof createJobSchema>): Promise<PublicJob> {
  let source = ''
  if (input.target === 'supplier_offers') {
    if (!input.connection_id) throw new AppError('VALIDATION_ERROR', 'Оберіть постачальника', 422)
    const { rows } = await pool.query('SELECT name FROM supplier_api_connections WHERE tenant_id = $1 AND id = $2', [tenantId, input.connection_id])
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Постачальника не знайдено', 404)
    source = String(rows[0].name)
  }
  const running = await pool.query("SELECT 1 FROM ai_jobs WHERE tenant_id = $1 AND status IN ('ready', 'running', 'paused') AND target = $2 AND COALESCE(connection_id::text, '') = COALESCE($3, '') LIMIT 1",
    [tenantId, input.target, input.connection_id ?? null])
  if (running.rows.length) throw new AppError('CONFLICT', 'Для цих товарів уже є незавершена задача. Завершіть або скасуйте її.', 409)
  const title = `${TASK_TITLE[input.task]}: ${input.target === 'products' ? 'наші товари' : 'товари ' + source} (${FILTER_TITLE[input.filter]})`
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const job = (await client.query(
      'INSERT INTO ai_jobs (tenant_id, created_by, target, task, filter, connection_id, title) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [tenantId, userId, input.target, input.task, input.filter, input.connection_id ?? null, title])).rows[0]
    const where = input.filter === 'messy_names' ? ' AND {name} ~* $3' : input.filter === 'russian_names' ? ' AND {name} ~* $3' : ''
    const pattern = input.filter === 'messy_names' ? MESSY_NAME_RE : input.filter === 'russian_names' ? RUSSIAN_NAME_RE : null
    const params: unknown[] = [job.id, tenantId, ...(pattern ? [pattern] : [])]
    const inserted = input.target === 'products'
      ? await client.query(`INSERT INTO ai_job_items (job_id, item_key, seq, old_name, sku)
          SELECT $1, p.id::text, row_number() OVER (ORDER BY p.name, p.id), p.name, p.sku FROM products p
           WHERE p.tenant_id = $2 AND p.deleted_at IS NULL${where.replace('{name}', 'p.name')} LIMIT ${JOB_MAX_ITEMS}`, params)
      : await client.query(`INSERT INTO ai_job_items (job_id, item_key, seq, old_name, sku)
          SELECT $1, o.connection_id::text || ':' || o.external_id, row_number() OVER (ORDER BY o.total_qty DESC, o.external_id), COALESCE(o.custom_name, o.name), o.number FROM supplier_offers o
           WHERE o.tenant_id = $2 AND o.connection_id = $${params.length + 1} AND NOT o.hidden${where.replace('{name}', 'COALESCE(o.custom_name, o.name)')} LIMIT ${JOB_MAX_ITEMS}`, [...params, input.connection_id])
    await client.query('UPDATE ai_jobs SET total = $2 WHERE id = $1', [job.id, inserted.rowCount ?? 0])
    await client.query('COMMIT')
    return getJob(tenantId, job.id)
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}

export async function listJobs(tenantId: string): Promise<PublicJob[]> {
  const { rows } = await pool.query('SELECT * FROM ai_jobs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 30', [tenantId])
  return rows.map(publicJob)
}

export async function getJob(tenantId: string, id: string): Promise<PublicJob> {
  const { rows } = await pool.query('SELECT * FROM ai_jobs WHERE tenant_id = $1 AND id = $2', [tenantId, id])
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Задачу не знайдено', 404)
  return publicJob(rows[0])
}

const NEXT_STATUS: Record<'start' | 'pause' | 'cancel', { from: string[]; to: string }> = {
  start: { from: ['ready', 'paused'], to: 'running' },
  pause: { from: ['running'], to: 'paused' },
  cancel: { from: ['ready', 'running', 'paused', 'review'], to: 'cancelled' },
}

export async function changeJobStatus(tenantId: string, id: string, action: 'start' | 'pause' | 'cancel'): Promise<PublicJob> {
  const rule = NEXT_STATUS[action]
  const { rowCount } = await pool.query(
    `UPDATE ai_jobs SET status = $3, started_at = CASE WHEN $3 = 'running' THEN COALESCE(started_at, now()) ELSE started_at END, last_error = CASE WHEN $3 = 'running' THEN NULL ELSE last_error END, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = ANY($4)`, [tenantId, id, rule.to, rule.from])
  if (!rowCount) throw new AppError('CONFLICT', 'Задача вже в іншому стані. Оновіть список.', 409)
  return getJob(tenantId, id)
}

export const ITEM_STATES = ['proposed', 'suspicious', 'unchanged', 'applied', 'rejected', 'failed', 'pending'] as const
export async function listJobItems(tenantId: string, id: string, state: string, page: number, perPage = 100) {
  await getJob(tenantId, id)
  const safeState = (ITEM_STATES as readonly string[]).includes(state) ? state : 'proposed'
  const size = Math.min(Math.max(perPage, 1), 500)
  const { rows } = await pool.query(
    'SELECT item_key, seq, old_name, sku, new_name, new_sku, state, note FROM ai_job_items WHERE job_id = $1 AND state = $2 ORDER BY seq LIMIT $3 OFFSET $4',
    [id, safeState, size, (Math.max(page, 1) - 1) * size])
  const counts = await pool.query('SELECT state, count(*)::int AS n FROM ai_job_items WHERE job_id = $1 GROUP BY state', [id])
  return { items: rows, counts: Object.fromEntries(counts.rows.map((row: { state: string; n: number }) => [row.state, row.n])) }
}

/** Підозрілий рядок, який власник переглянув і погодив (або навпаки — відхилив готовий). */
export async function setItemsState(tenantId: string, id: string, keys: string[], to: 'proposed' | 'rejected'): Promise<number> {
  await getJob(tenantId, id)
  const { rowCount } = await pool.query(
    "UPDATE ai_job_items SET state = $3, updated_at = now() WHERE job_id = $1 AND item_key = ANY($2) AND state IN ('proposed', 'suspicious', 'rejected')",
    [id, keys.slice(0, 5000), to])
  await refreshCounters(id)
  return rowCount ?? 0
}

/** Товари постачальника: «наша назва» записується в хмарі одразу, прайс її не перезапише. */
export async function applyOfferItems(tenantId: string, id: string, limit = 5000): Promise<number> {
  const job = await getJob(tenantId, id)
  if (job.target !== 'supplier_offers') throw new AppError('VALIDATION_ERROR', 'Наші товари застосовуються через головний ПК', 422)
  const { rowCount } = await pool.query(
    `WITH picked AS (
       SELECT item_key, new_name FROM ai_job_items WHERE job_id = $1 AND state = 'proposed' ORDER BY seq LIMIT $3 FOR UPDATE SKIP LOCKED
     ), written AS (
       UPDATE supplier_offers o SET custom_name = left(p.new_name, 400), updated_at = now() FROM picked p
        WHERE o.tenant_id = $2 AND o.connection_id::text || ':' || o.external_id = p.item_key RETURNING p.item_key
     )
     UPDATE ai_job_items i SET state = 'applied', updated_at = now() FROM written w WHERE i.job_id = $1 AND i.item_key = w.item_key`,
    [id, tenantId, Math.min(Math.max(limit, 1), 20_000)])
  await refreshCounters(id)
  return rowCount ?? 0
}

/** Наші товари: головний ПК записав пачку — відмічаємо, що записано і що ПК відхилив (з причиною). */
export async function markProductItems(tenantId: string, id: string, applied: string[], failed: Array<{ key: string; error: string }>): Promise<void> {
  const job = await getJob(tenantId, id)
  if (job.target !== 'products') throw new AppError('VALIDATION_ERROR', 'Це задача по товарах постачальника', 422)
  if (applied.length) await pool.query("UPDATE ai_job_items SET state = 'applied', updated_at = now() WHERE job_id = $1 AND item_key = ANY($2) AND state = 'proposed'", [id, applied.slice(0, 5000)])
  for (const row of failed.slice(0, 5000)) {
    await pool.query("UPDATE ai_job_items SET state = 'failed', note = left($3, 500), updated_at = now() WHERE job_id = $1 AND item_key = $2 AND state = 'proposed'", [id, row.key, row.error])
  }
  await refreshCounters(id)
}

async function refreshCounters(jobId: string): Promise<void> {
  await pool.query(
    `UPDATE ai_jobs j SET
       processed = c.processed, changed = c.changed, suspicious = c.suspicious, applied = c.applied, updated_at = now(),
       status = CASE WHEN j.status = 'review' AND c.open = 0 THEN 'done' ELSE j.status END
       FROM (SELECT count(*) FILTER (WHERE state NOT IN ('pending', 'working'))::int AS processed,
                    count(*) FILTER (WHERE state IN ('proposed', 'suspicious', 'applied', 'rejected', 'failed'))::int AS changed,
                    count(*) FILTER (WHERE state = 'suspicious')::int AS suspicious,
                    count(*) FILTER (WHERE state = 'applied')::int AS applied,
                    count(*) FILTER (WHERE state IN ('pending', 'working', 'proposed', 'suspicious'))::int AS open
               FROM ai_job_items WHERE job_id = $1) c
      WHERE j.id = $1`, [jobId])
}

type Claimed = { item_key: string; seq: number; old_name: string; sku: string | null }

async function claimChunk(jobId: string): Promise<Claimed[]> {
  const { rows } = await pool.query(
    `UPDATE ai_job_items SET state = 'working', claimed_at = now()
      WHERE (job_id, item_key) IN (
        SELECT job_id, item_key FROM ai_job_items
         WHERE job_id = $1 AND (state = 'pending' OR (state = 'working' AND claimed_at < now() - make_interval(secs => $3)))
         ORDER BY seq LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING item_key, seq, old_name, sku`, [jobId, JOB_CHUNK, JOB_STALE_CLAIM_MS / 1000])
  return rows.sort((a: Claimed, b: Claimed) => a.seq - b.seq)
}

export type JobModel = { complete: (budget: AiExecutionBudget, input: { system: string; text: string; maxTokens?: number; effort?: 'low' | 'medium' | 'high' }) => Promise<ClaudeUsage & { text: string; truncated: boolean }> }

/** Одна пачка: запит до моделі, перевірка кожної назви, запис результату. Помилка моделі повертає пачку в чергу. */
export async function processChunk(job: Pick<JobRow, 'id' | 'task'>, items: Claimed[], model: JobModel, budget: AiExecutionBudget): Promise<{ cost: number; usage: ClaudeUsage }> {
  const text = items.map(item => `№${item.seq}\t${item.sku?.trim() || '-'}\t${item.old_name.replace(/\s+/g, ' ').trim()}`).join('\n')
  try {
    const answer = await model.complete(budget, { system: jobSystemPrompt(job.task), text, maxTokens: 16000, effort: 'low' })
    if (answer.truncated) throw new AppError('AI_RESPONSE_TOO_LARGE', 'Відповідь обрізано', 422)
    const replies = parseJobReply(answer.text, new Set(items.map(item => item.seq)))
    for (const item of items) {
      const reply = replies.get(item.seq)
      const verdict = reply ? judgeName(job.task, item.old_name, item.sku, reply.name, reply.sku) : { state: 'unchanged' as const, name: null, sku: null, note: null }
      await pool.query('UPDATE ai_job_items SET state = $3, new_name = $4, new_sku = $5, note = $6, claimed_at = NULL, updated_at = now() WHERE job_id = $1 AND item_key = $2',
        [job.id, item.item_key, verdict.state, verdict.name, verdict.sku, verdict.note])
    }
    return { cost: usageCostUsd(answer), usage: answer }
  } catch (error) {
    // Пачка повертається в чергу; збій однієї пачки не зупиняє задачу.
    await pool.query("UPDATE ai_job_items SET state = 'pending', claimed_at = NULL WHERE job_id = $1 AND item_key = ANY($2) AND state = 'working'", [job.id, items.map(item => item.item_key)])
    throw error
  }
}

/**
 * Пробудження від планувальника: працюючі задачі, по JOB_PARALLEL пачок одночасно, поки є час.
 * Ключ Anthropic — із налаштувань магазину; якщо помічник вимкнений чи ключа немає — задача стає на паузу з причиною.
 */
export async function runAiJobsStep(deps: { model?: (apiKey: string, model: string) => JobModel; now?: () => number } = {}): Promise<{ jobs: number; chunks: number; errors: number }> {
  const now = deps.now ?? Date.now
  const deadline = now() + JOB_RUN_MS
  const { rows: jobs } = await pool.query("SELECT * FROM ai_jobs WHERE status = 'running' ORDER BY updated_at LIMIT 3")
  if (!jobs.length) return { jobs: 0, chunks: 0, errors: 0 }
  // Модуль помічника важкий — підвантажуємо лише коли є робота.
  const { getAiConfig, recordAiUsage } = await import('./aiService.js')
  let chunks = 0, errors = 0
  for (const job of jobs as JobRow[]) {
    const config = await getAiConfig(job.tenant_id).catch(() => null)
    if (!config?.enabled || !config.apiKey) {
      await pool.query("UPDATE ai_jobs SET status = 'paused', last_error = $2, updated_at = now() WHERE id = $1",
        [job.id, 'Помічник вимкнений або немає ключа Anthropic (Налаштування → ШІ).'])
      continue
    }
    const model = deps.model ? deps.model(config.apiKey, config.model) : new ClaudeClient(config.apiKey, isClaudeModel(config.model) ? config.model : 'claude-sonnet-5-5')
    let lastError: string | null = null
    while (now() < deadline - 20_000) {
      const batch: Claimed[][] = []
      for (let i = 0; i < JOB_PARALLEL; i++) {
        const items = await claimChunk(job.id)
        if (!items.length) break
        batch.push(items)
      }
      if (!batch.length) break
      const budget = new AiExecutionBudget(Math.max(5_000, deadline - now()))
      const results = await Promise.allSettled(batch.map(items => processChunk(job, items, model, budget)))
      budget.dispose()
      let cost = 0, prompt = 0, completion = 0, adjust = 0
      for (const result of results) {
        if (result.status === 'fulfilled') {
          chunks += 1; cost += result.value.cost
          prompt += result.value.usage.promptTokens; completion += result.value.usage.completionTokens; adjust += result.value.usage.costAdjustUsd ?? 0
        } else {
          errors += 1
          lastError = result.reason instanceof Error ? result.reason.message : 'Помилка ШІ'
          logger.warn({ job: job.id, code: (result.reason as AppError)?.code }, '[ai-jobs] chunk failed')
        }
      }
      if (prompt || completion) await recordAiUsage(job.tenant_id, job.created_by, config.model, prompt, completion, undefined, adjust).catch(() => undefined)
      await pool.query('UPDATE ai_jobs SET cost_usd = cost_usd + $2, last_error = $3, updated_at = now() WHERE id = $1', [job.id, cost, lastError])
      await refreshCounters(job.id)
      // Ліміт чи порожній баланс Anthropic — пауза з причиною, а не нескінченні повтори.
      if (results.some(result => result.status === 'rejected' && ['AI_QUOTA_EXCEEDED', 'AI_KEY_INVALID'].includes((result.reason as AppError)?.code))) {
        await pool.query("UPDATE ai_jobs SET status = 'paused', updated_at = now() WHERE id = $1 AND status = 'running'", [job.id])
        break
      }
      const state = (await pool.query('SELECT status FROM ai_jobs WHERE id = $1', [job.id])).rows[0]?.status
      if (state !== 'running') break
    }
    const left = (await pool.query("SELECT count(*)::int AS n FROM ai_job_items WHERE job_id = $1 AND state IN ('pending', 'working')", [job.id])).rows[0]?.n ?? 0
    if (!left) {
      await pool.query("UPDATE ai_jobs SET status = 'review', updated_at = now() WHERE id = $1 AND status = 'running'", [job.id])
      await refreshCounters(job.id)
    }
  }
  return { jobs: jobs.length, chunks, errors }
}
