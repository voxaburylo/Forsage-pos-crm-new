import { z } from 'zod'
import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { tillStatus } from './tillCommandService.js'

/**
 * 22.11.2026, рішення власника: «веб повний, але робота тільки через головний ПК, щоб нічого не задвоїлось».
 * Веб — ще один «ПК менеджера через інтернет»: кожна дія вебу — запит до головного ПК, який виконує її
 * у своїй базі тим самим кодом і з правами того самого працівника (executeLanCommand). Сервер лише
 * передає запит і відповідь. Повторів немає: запит, не забраний касою за 30 с, не виконується ніколи;
 * якщо відповідь не встигла — веб каже перевірити на касі й нічого не надсилає вдруге.
 */
export const RPC_CLAIM_SECONDS = 30
export const RPC_WAIT_MS = 25_000
const RPC_POLL_MS = 150
/** Канали, які ніколи не йдуть із вебу: сесія, мережа, друк, фіскалізація, копії бази, журнал проблем ПК. */
const WEB_DENIED_PREFIXES = [
  'desktop:auth:', 'desktop:lan:', 'desktop:print:', 'desktop:fiscal:', 'desktop:sync:', 'desktop:bootstrap:',
  'desktop:backup', 'desktop:problems:', 'desktop:web-rpc:', 'desktop:window:', 'desktop:get-runtime-info',
  'desktop:catalog:cleanup-', 'desktop:orders:offline-status', 'desktop:orders:discard-offline', 'desktop:orders:retry-offline',
  'desktop:diagnostic',
  // Автор зміни PIN/пароля передається аргументом — з вебу його можна було б підробити; лише команда сервера.
  'desktop:staff:apply-remote-secret',
]
export function webRpcChannelAllowed(channel: string): boolean {
  return /^desktop:[a-z0-9:-]{1,120}$/.test(channel) && !WEB_DENIED_PREFIXES.some(prefix => channel.startsWith(prefix))
}
/** Хто з вебу може працювати через головний ПК (касир — лише на касі). Права всередині перевіряє каса. */
export const WEB_RPC_ROLES = ['owner', 'admin', 'manager'] as const
export const MAX_RPC_BYTES = 3_500_000

export const rpcRequestSchema = z.object({
  channel: z.string().max(130),
  args: z.array(z.unknown()).max(12),
}).strict()
export const rpcResultSchema = z.object({
  status: z.enum(['done', 'failed']),
  result: z.unknown().optional(),
  error: z.string().max(1000).nullable().optional(),
}).strict()

type Wake = (tenantId: string) => Promise<void>
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Будимо касу одразу (Supabase Realtime, без даних у повідомленні); каса й так опитує кожні кілька секунд. */
export const wakeTill: Wake = async tenantId => {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) return
  await fetch(`${url}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ topic: tillWakeTopic(tenantId), event: 'wake', payload: {} }] }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => undefined)
}
export function tillWakeTopic(tenantId: string): string {
  return `till-rpc-${tenantId}`
}

export async function callTill(tenantId: string, userId: string, input: z.infer<typeof rpcRequestSchema>, wake: Wake = wakeTill,
  waitMs = RPC_WAIT_MS) {
  if (!webRpcChannelAllowed(input.channel)) throw new AppError('FORBIDDEN', 'Ця дія доступна лише на самій касі.', 403)
  const argsJson = JSON.stringify(input.args)
  if (argsJson.length > MAX_RPC_BYTES) throw new AppError('VALIDATION_ERROR', 'Завеликий запит. Зменште фото або кількість рядків.', 413)
  if (!(await tillStatus(tenantId)).online) throw new AppError('TILL_OFFLINE', 'Головний ПК не на зв\'язку. Зараз доступний лише перегляд.', 409)
  const { rows } = await pool.query(
    `INSERT INTO till_rpc (tenant_id, user_id, channel, args) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [tenantId, userId, input.channel, argsJson],
  )
  const id = rows[0].id as string
  await wake(tenantId)
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await sleep(RPC_POLL_MS)
    const found = await pool.query('SELECT status, result, error FROM till_rpc WHERE id = $1', [id])
    const row = found.rows[0]
    if (row?.status === 'done') return row.result ?? null
    if (row?.status === 'failed') throw new AppError('TILL_REFUSED', String(row.error || 'Каса не змогла виконати дію'), 422)
  }
  // Не забрали — гасимо, щоб каса вже не виконала. Забрали, але не відповіли — результат невідомий.
  const expired = await pool.query(`UPDATE till_rpc SET status = 'expired', finished_at = now() WHERE id = $1 AND status = 'pending'`, [id])
  if (expired.rowCount) throw new AppError('TILL_OFFLINE', 'Головний ПК не відповів. Дію не виконано — спробуйте ще раз.', 504)
  throw new AppError('TILL_TIMEOUT', 'Головний ПК не встиг відповісти. Перевірте результат на касі, перш ніж повторювати.', 504)
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
