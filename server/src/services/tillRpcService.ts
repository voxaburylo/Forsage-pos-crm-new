import { z } from 'zod'
import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { RPC_CLAIM_SECONDS, touchWebPresence } from './tillLinkService.js'
import { wakeTill, type TillWake } from './tillWake.js'

/**
 * 22.11.2026, рішення власника: «веб повний, але робота тільки через головний ПК, щоб нічого не задвоїлось».
 * Веб — ще один «ПК менеджера через інтернет»: кожна дія вебу — запит до головного ПК, який виконує її
 * у своїй базі тим самим кодом і з правами того самого працівника (executeLanCommand). Сервер лише
 * передає запит і відповідь. Повторів немає: запит, не забраний касою за 45 с, не виконується ніколи.
 * Якщо каса запит забрала, але відповісти не встигла, веб чекає відповіді ЗА НОМЕРОМ ТОГО САМОГО ЗАПИТУ
 * (readRpc) і нічого не надсилає вдруге — так дія не може виконатись двічі через «спробуйте ще раз».
 */
export { RPC_CLAIM_SECONDS }
export { wakeTill, tillWakeTopic } from './tillWake.js'
/** Скільки сервер чекає, що каса забере запит. Довше за рідке опитування каси (30 с): сигнал міг не дійти. */
export const RPC_UNCLAIMED_WAIT_MS = 40_000
/** Скільки сервер чекає відповідь загалом; далі веб питає сам за номером запиту. */
export const RPC_WAIT_MS = 55_000
const RPC_POLL_MS = 150
/** Після перших секунд питаємо базу рідше: довга дія каси не має коштувати сотень запитів. */
const RPC_POLL_SLOW_MS = 500
const RPC_POLL_SLOW_AFTER_MS = 3_000
/** Канали, які ніколи не йдуть із вебу: сесія, мережа, друк, фіскалізація, копії бази, журнал проблем ПК. */
const WEB_DENIED_PREFIXES = [
  'desktop:auth:', 'desktop:lan:', 'desktop:link:', 'desktop:print:', 'desktop:fiscal:', 'desktop:sync:', 'desktop:bootstrap:',
  'desktop:backup', 'desktop:problems:', 'desktop:web-rpc:', 'desktop:window:', 'desktop:get-runtime-info',
  'desktop:catalog:cleanup-', 'desktop:orders:offline-status', 'desktop:orders:discard-offline', 'desktop:orders:retry-offline',
  'desktop:diagnostic',
  // Автор зміни PIN/пароля передається аргументом — з вебу його можна було б підробити; лише команда сервера.
  'desktop:staff:apply-remote-secret',
]
/**
 * 23.11.2026: гроші в касі — лише на самій касі (план вебу 22.11.2026). Екрани вебу цих дій не показують,
 * а тут другий замок: головний ПК і сервер відхиляють їх, навіть якщо запит склали вручну.
 * Скасування замовлення сюди не входить: воно гроші не видає (оплата лише зараховується на рахунок клієнта).
 */
export const WEB_MONEY_CHANNELS: readonly string[] = [
  'desktop:pos:checkout', 'desktop:pos:create-return', 'desktop:pos:refund-core-deposit', 'desktop:pos:create-cash-operation',
  'desktop:pos:open-shift', 'desktop:pos:close-shift', 'desktop:pos:remote-close-shift', 'desktop:pos:reconcile',
  'desktop:pos:pay-debt', 'desktop:pos:add-customer-deposit', 'desktop:pos:payout-customer-deposit',
  'desktop:pos:suspend-sale', 'desktop:pos:resume-sale', 'desktop:pos:confirm-resume-sale', 'desktop:pos:discard-suspended-sale',
  'desktop:orders:add-payment', 'desktop:orders:complete',
  'desktop:staff:create-salary', 'desktop:staff:delete-salary', 'desktop:staff:daily-payout', 'desktop:staff:tire-cash-handover',
]
export function webRpcChannelAllowed(channel: string): boolean {
  return /^desktop:[a-z0-9:-]{1,120}$/.test(channel) && !WEB_DENIED_PREFIXES.some(prefix => channel.startsWith(prefix))
    && !WEB_MONEY_CHANNELS.includes(channel)
}
/** Хто з вебу може працювати через головний ПК (касир — лише на касі). Права всередині перевіряє каса. */
export const WEB_RPC_ROLES = ['owner', 'admin', 'manager'] as const
export const MAX_RPC_BYTES = 3_500_000

export const rpcRequestSchema = z.object({
  channel: z.string().max(130),
  args: z.array(z.unknown()).max(12),
  /** Новий веб уміє дочекатися відповіді за номером запиту; старий отримує колишню відмову. */
  pending_ok: z.boolean().optional(),
}).strict()
export const rpcResultSchema = z.object({
  status: z.enum(['done', 'failed']),
  result: z.unknown().optional(),
  error: z.string().max(1000).nullable().optional(),
}).strict()

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const refused = (error: unknown) => new AppError('TILL_REFUSED', String(error || 'Каса не змогла виконати дію'), 422)

export async function callTill(tenantId: string, userId: string, input: z.infer<typeof rpcRequestSchema>, wake: TillWake = wakeTill,
  waitMs = RPC_WAIT_MS, unclaimedMs = RPC_UNCLAIMED_WAIT_MS) {
  if (!webRpcChannelAllowed(input.channel)) throw new AppError('FORBIDDEN', 'Ця дія доступна лише на самій касі.', 403)
  const argsJson = JSON.stringify(input.args)
  if (argsJson.length > MAX_RPC_BYTES) throw new AppError('VALIDATION_ERROR', 'Завеликий запит. Зменште фото або кількість рядків.', 413)
  // Запит із вебу — це й позначка «у вебі працюють»: каса переходить на часте опитування.
  if (!(await touchWebPresence(tenantId, async () => undefined)).online) throw new AppError('TILL_OFFLINE', 'Головний ПК не на зв\'язку. Зараз доступний лише перегляд.', 409)
  const { rows } = await pool.query(
    `INSERT INTO till_rpc (tenant_id, user_id, channel, args) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [tenantId, userId, input.channel, argsJson],
  )
  const id = rows[0].id as string
  await wake(tenantId)
  const started = Date.now()
  let claimed = false
  for (;;) {
    const elapsed = Date.now() - started
    if (elapsed >= (claimed ? waitMs : Math.min(unclaimedMs, waitMs))) break
    await sleep(elapsed < RPC_POLL_SLOW_AFTER_MS ? RPC_POLL_MS : RPC_POLL_SLOW_MS)
    const found = await pool.query('SELECT status, result, error FROM till_rpc WHERE id = $1', [id])
    const row = found.rows[0]
    if (row?.status === 'done') return row.result ?? null
    if (row?.status === 'failed') throw refused(row.error)
    if (row?.status === 'claimed') claimed = true
  }
  // Не забрали — гасимо, щоб каса вже не виконала. Забрали, але не відповіли — каса ще виконує.
  const expired = await pool.query(`UPDATE till_rpc SET status = 'expired', finished_at = now() WHERE id = $1 AND status = 'pending'`, [id])
  if (expired.rowCount) throw new AppError('TILL_OFFLINE', 'Головний ПК не відповів. Дію не виконано — спробуйте ще раз.', 504)
  if (input.pending_ok) throw new AppError('TILL_PENDING', 'Головний ПК ще виконує дію.', 202, { request_id: id })
  throw new AppError('TILL_TIMEOUT', 'Головний ПК не встиг відповісти. Перевірте результат на касі, перш ніж повторювати.', 504)
}

/**
 * Веб: що сталося з моїм запитом. Лише власний запит; сам запит удруге не надсилається.
 * `pending` — каса ще виконує; `expired` — каса його так і не забрала (нічого не виконано).
 */
export async function readRpc(tenantId: string, userId: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new AppError('VALIDATION_ERROR', 'Некоректний номер запиту', 422)
  const { rows } = await pool.query('SELECT status, result, error FROM till_rpc WHERE tenant_id = $1 AND user_id = $2 AND id = $3', [tenantId, userId, id])
  const row = rows[0]
  if (!row) throw new AppError('NOT_FOUND', 'Запит не знайдено', 404)
  if (row.status === 'done') return { status: 'done' as const, result: row.result ?? null }
  if (row.status === 'failed') return { status: 'failed' as const, error: String(row.error || 'Каса не змогла виконати дію') }
  return { status: row.status === 'expired' ? 'expired' as const : 'pending' as const }
}

/** Каса: забрати свіжі запити вебу (атомарно, кожен лише раз). */
export async function claimRpc(tenantId: string, deviceId: string) {
  if (!z.string().uuid().safeParse(deviceId).success) throw new AppError('VALIDATION_ERROR', 'Некоректний ідентифікатор каси', 422)
  await pool.query(
    `INSERT INTO till_presence (tenant_id, device_id, seen_at) VALUES ($1, $2, now())
     ON CONFLICT (tenant_id) DO UPDATE SET device_id = EXCLUDED.device_id, seen_at = now()`,
    [tenantId, deviceId],
  )
  const { rows } = await pool.query(
    `UPDATE till_rpc SET status = 'claimed', device_id = $2, claimed_at = now()
      WHERE id IN (SELECT id FROM till_rpc WHERE tenant_id = $1 AND status = 'pending'
                     AND created_at > now() - make_interval(secs => $3)
                   ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED)
      RETURNING id, user_id, channel, args`,
    [tenantId, deviceId, RPC_CLAIM_SECONDS],
  )
  // Старі записи не потрібні: запит живе секунди.
  void pool.query(`DELETE FROM till_rpc WHERE created_at < now() - interval '1 day'`).catch(() => undefined)
  return rows.map(row => ({ id: row.id as string, user_id: row.user_id as string, channel: row.channel as string, args: row.args as unknown[] }))
}

export async function finishRpc(tenantId: string, deviceId: string, id: string, input: z.infer<typeof rpcResultSchema>) {
  if (![deviceId, id].every(value => z.string().uuid().safeParse(value).success)) throw new AppError('VALIDATION_ERROR', 'Некоректна відповідь каси', 422)
  const result = input.status === 'done' ? JSON.stringify(input.result ?? null) : null
  if (result && result.length > MAX_RPC_BYTES) {
    input = { status: 'failed', error: 'Відповідь каси завелика для вебу. Звузьте пошук або період.' }
  }
  const { rowCount } = await pool.query(
    `UPDATE till_rpc SET status = $4, result = $5::jsonb, error = $6, finished_at = now()
      WHERE tenant_id = $1 AND id = $2 AND device_id = $3 AND status = 'claimed'`,
    [tenantId, id, deviceId, input.status, input.status === 'done' ? result : null, input.error ?? null],
  )
  if (!rowCount) throw new AppError('NOT_FOUND', 'Запит не знайдено або вже завершено', 404)
  return { ok: true }
}
