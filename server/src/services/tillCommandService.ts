import { z } from 'zod'
import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'

/**
 * Запис із вебу через касу (рішення власника 17.11.2026).
 * Веб ставить команду → каса в мережі забирає її (опитування кожні кілька секунд) → виконує
 * у своїй базі → відповідає. Черги немає: команду, яку не забрали за 30 с, не виконано ніколи.
 * Ідемпотентність — за operation_id. Дозволені лише перелічені команди; залишки, продажі й оплати —
 * тільки на касі.
 */
export const COMMAND_TTL_SECONDS = 30
export const TILL_ONLINE_SECONDS = 20
export const WEB_COMMAND_ROLES = ['owner', 'admin', 'manager'] as const
export const TILL_ROLES = ['owner', 'admin', 'manager', 'cashier'] as const

const money = z.number().int().min(0).max(100_000_000)
const text = (max: number) => z.string().trim().max(max)
/** Поля картки, які можна змінити з вебу. Закупка, кількість, активність — лише на касі. */
const productFields = z.object({
  name: text(300).min(1).optional(),
  sku: text(100).min(1).optional(),
  barcode: text(64).nullable().optional(),
  retail_price: money.optional(),
  storage_bin: text(64).nullable().optional(),
  notes: text(2000).nullable().optional(),
}).strict()

export const productUpdatePayload = z.object({
  product_id: z.string().uuid(),
  /** Те, що бачив працівник у вебі: каса відмовить, якщо поле встигли змінити інакше. */
  base: productFields,
  changes: productFields.refine(value => Object.keys(value).length > 0, 'Немає змін'),
}).strict().refine(value => Object.keys(value.changes).every(key => key in value.base), 'Для кожної зміни потрібне попереднє значення')

/** 21.11.2026: закриття незакритої зміни з вебу — каса читає відкриті зміни і закриває у своїй базі. */
export const shiftClosePayload = z.object({
  shift_id: z.string().uuid(),
  cashier_id: z.string().uuid(),
  /** Готівка в касі за перерахунком, у копійках. */
  actual_amount: money,
  comment: z.string().trim().min(3).max(300),
}).strict()

/**
 * 22.11.2026: замовлення з вебу (телефон). Каса створює його у своїй базі; грошей у команді немає.
 * Ціни в копійках; ціна продажу не нижча за закупку (жорстке правило власника), 0 = «ще не знаємо».
 */
const orderItem = z.object({
  name: text(300).min(1),
  sku: text(100).nullable().optional(),
  qty: z.number().positive().max(1_000_000).refine(value => Math.round(value * 1000) === value * 1000, 'Кількість: не більше трьох знаків'),
  sell_price: money,
  buy_price: money.optional(),
}).strict().refine(item => !(item.sell_price > 0 && (item.buy_price ?? 0) > 0 && item.sell_price < (item.buy_price ?? 0)), 'Ціна продажу нижча за закупку')
export const orderSavePayload = z.object({
  customer_phone: z.string().regex(/^[0-9]{10,12}$/).nullable().optional(),
  customer_name: text(120).nullable().optional(),
  car_make: text(60).nullable().optional(),
  car_model: text(60).nullable().optional(),
  car_year: z.number().int().min(1886).max(2100).nullable().optional(),
  vin: z.string().regex(/^[A-HJ-NPR-Z0-9]{17}$/).nullable().optional(),
  comment: text(1000).nullable().optional(),
  author: text(120).nullable().optional(),
  items: z.array(orderItem).min(1).max(60),
}).strict().refine(order => Boolean(order.customer_phone || order.customer_name), 'Потрібен телефон або ім’я клієнта')

export const createCommandSchema = z.discriminatedUnion('command', [
  z.object({ operation_id: z.string().uuid(), command: z.literal('order.save'), payload: orderSavePayload }).strict(),
  z.object({ operation_id: z.string().uuid(), command: z.literal('product.update'), payload: productUpdatePayload }).strict(),
  z.object({ operation_id: z.string().uuid(), command: z.literal('shift.list'), payload: z.object({}).strict() }).strict(),
  z.object({ operation_id: z.string().uuid(), command: z.literal('shift.close'), payload: shiftClosePayload }).strict(),
])
/** Зміни каси з вебу — лише власник або адміністратор. */
export const SHIFT_COMMAND_ROLES = ['owner', 'admin'] as const
export function commandAllowedForRole(command: string, role: string | undefined): boolean {
  return !command.startsWith('shift.') || (SHIFT_COMMAND_ROLES as readonly string[]).includes(role ?? '')
}

export const commandResultSchema = z.object({
  status: z.enum(['done', 'failed']),
  result: z.record(z.unknown()).nullable().optional(),
  error: z.string().max(500).nullable().optional(),
}).strict()

const stable = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)

export async function tillStatus(tenantId: string) {
  const { rows } = await pool.query(
    `SELECT seen_at, seen_at > now() - make_interval(secs => $2) AS online FROM till_presence WHERE tenant_id = $1`,
    [tenantId, TILL_ONLINE_SECONDS],
  )
  return { online: Boolean(rows[0]?.online), seen_at: rows[0] ? new Date(rows[0].seen_at).toISOString() : null }
}

export async function createCommand(tenantId: string, userId: string, input: z.infer<typeof createCommandSchema>) {
  if (!(await tillStatus(tenantId)).online) throw new AppError('TILL_OFFLINE', 'Каса зараз не в мережі. Зміну можна внести лише тоді, коли програма на касі увімкнена й має інтернет.', 409)
  const { rows } = await pool.query(
    `INSERT INTO till_commands (tenant_id, operation_id, command, payload, requested_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (tenant_id, operation_id) DO NOTHING
     RETURNING operation_id, status`,
    [tenantId, input.operation_id, input.command, JSON.stringify(input.payload), userId],
  )
  if (rows[0]) return { operation_id: rows[0].operation_id as string, status: rows[0].status as string }
  // Повтор того самого запиту — та сама команда; інший вміст під тим самим номером — відмова.
  const existing = await pool.query('SELECT command, payload, status FROM till_commands WHERE tenant_id = $1 AND operation_id = $2', [tenantId, input.operation_id])
  const row = existing.rows[0]
  if (!row || row.command !== input.command || stable(row.payload) !== stable(input.payload))
    throw new AppError('CONFLICT', 'Номер операції вже використано для іншої зміни', 409)
  return { operation_id: input.operation_id, status: row.status as string }
}

/** Стан команди для вебу. Незабрану вчасно команду тут же позначаємо простроченою — каса її вже не візьме. */
export async function readCommand(tenantId: string, operationId: string) {
  if (!z.string().uuid().safeParse(operationId).success) throw new AppError('NOT_FOUND', 'Команду не знайдено', 404)
  await pool.query(
    `UPDATE till_commands SET status = 'expired', finished_at = now()
      WHERE tenant_id = $1 AND operation_id = $2 AND status = 'pending' AND created_at <= now() - make_interval(secs => $3)`,
    [tenantId, operationId, COMMAND_TTL_SECONDS],
  )
  const { rows } = await pool.query(
    'SELECT operation_id, command, status, result, error, created_at, finished_at FROM till_commands WHERE tenant_id = $1 AND operation_id = $2',
    [tenantId, operationId],
  )
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Команду не знайдено', 404)
  const row = rows[0]
  return { operation_id: row.operation_id, command: row.command, status: row.status, result: row.result ?? null, error: row.error ?? null,
    created_at: new Date(row.created_at).toISOString(), finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null }
}

/** Каса: «я в мережі» + забрати свіжі команди. Забрати можна лише раз (атомарно), лише свіжу. */
export async function claimCommands(tenantId: string, deviceId: string) {
  if (!z.string().uuid().safeParse(deviceId).success) throw new AppError('VALIDATION_ERROR', 'Некоректний ідентифікатор каси', 422)
  await pool.query(
    `INSERT INTO till_presence (tenant_id, device_id, seen_at) VALUES ($1, $2, now())
     ON CONFLICT (tenant_id) DO UPDATE SET device_id = EXCLUDED.device_id, seen_at = now()`,
    [tenantId, deviceId],
  )
  const { rows } = await pool.query(
    `UPDATE till_commands SET status = 'claimed', device_id = $2, claimed_at = now()
      WHERE id IN (SELECT id FROM till_commands WHERE tenant_id = $1 AND status = 'pending'
                     AND created_at > now() - make_interval(secs => $3)
                   ORDER BY created_at LIMIT 5 FOR UPDATE SKIP LOCKED)
      RETURNING id, operation_id, command, payload, requested_by, created_at`,
    [tenantId, deviceId, COMMAND_TTL_SECONDS],
  )
  return rows.map(row => ({ id: row.id as string, operation_id: row.operation_id as string, command: row.command as string,
    payload: row.payload, requested_by: row.requested_by as string, created_at: new Date(row.created_at).toISOString() }))
}

export async function finishCommand(tenantId: string, deviceId: string, id: string, input: z.infer<typeof commandResultSchema>) {
  if (![deviceId, id].every(value => z.string().uuid().safeParse(value).success)) throw new AppError('VALIDATION_ERROR', 'Некоректна відповідь каси', 422)
  const { rowCount } = await pool.query(
    `UPDATE till_commands SET status = $4, result = $5::jsonb, error = $6, finished_at = now()
      WHERE tenant_id = $1 AND id = $2 AND device_id = $3 AND status = 'claimed'`,
    [tenantId, id, deviceId, input.status, input.result ? JSON.stringify(input.result) : null, input.error ?? null],
  )
  if (!rowCount) throw new AppError('NOT_FOUND', 'Команду не знайдено або вже завершено', 404)
  return { ok: true }
}
