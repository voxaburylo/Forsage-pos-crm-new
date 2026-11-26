import { z } from 'zod'
import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { wakeTill } from './tillWake.js'

/**
 * Запис із вебу через касу (рішення власника 17.11.2026).
 * Веб ставить команду → каса в мережі забирає її (сигнал одразу, рідке опитування — страховка) → виконує
 * у своїй базі → відповідає. Черги немає: команду, яку не забрали за 45 с, не виконано ніколи.
 * Ідемпотентність — за operation_id. Дозволені лише перелічені команди; залишки, продажі й оплати —
 * тільки на касі.
 */
/** 22.11.2026: довше за рідке опитування каси (30 с) — якщо сигнал «прокинься» не дійшов, каса ще встигне забрати команду. */
export const COMMAND_TTL_SECONDS = 45
/** 22.11.2026: каса питає сервер раз на 30 с, коли у вебі нікого немає (див. tillLinkService), тож «на зв'язку» — це до 75 с тиші. */
export const TILL_ONLINE_SECONDS = 75
/**
 * 22.11.2026 (етап 8): замовлення з вебу чекає касу на сервері до 12 годин — його можна оформити,
 * коли каса не в мережі. Це безпечно лише для команд, які не залежать від стану бази каси
 * і мають номер операції (повтор не дає дубля). Правка картки й зміни каси чекати не можуть.
 */
export const QUEUE_TTL_SECONDS = 12 * 60 * 60
export const QUEUED_COMMAND = 'order.save'
/** 22.11.2026: накладна з телефона теж чекає касу — вона лише лягає у «вхідні» каси й нічого не проводить. */
export const INVOICE_DRAFT_COMMAND = 'invoice.draft'
/**
 * 22.11.2026 (рішення власника: PIN і пароль можна змінити й тоді, коли головний ПК вимкнено): сервер кладе касі
 * лише ХЕШ (не сам PIN чи пароль). Каса застосує його, коли зʼявиться. Чекає довше — до 7 днів.
 */
export const STAFF_SECRET_COMMAND = 'staff.secret'
export const STAFF_SECRET_TTL_SECONDS = 7 * 24 * 60 * 60
export const QUEUED_COMMANDS: readonly string[] = [QUEUED_COMMAND, INVOICE_DRAFT_COMMAND, STAFF_SECRET_COMMAND]
const isQueued = (command: string) => QUEUED_COMMANDS.includes(command)
/**
 * 24.11.2026: замовлення із сайту (автор «Сайт») чекає касу до 7 днів — сайт приймає замовлення й у вихідні.
 * Це той самий бланк order.save, тож каса вміє його без оновлення.
 */
export const SITE_ORDER_AUTHOR = 'Сайт'
export const PENDING_COMMAND_TTL_SQL = `make_interval(secs => CASE WHEN command IN ('staff.secret', 'category.create', 'order.site_cancel') THEN 604800 WHEN command = '${QUEUED_COMMAND}' AND payload->>'author' = '${SITE_ORDER_AUTHOR}' THEN 604800 WHEN command IN ('${QUEUED_COMMAND}', '${INVOICE_DRAFT_COMMAND}') THEN ${QUEUE_TTL_SECONDS} ELSE ${COMMAND_TTL_SECONDS} END)`
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
  /** Картка зі складу: каса сама бере з неї назву, артикул і закупку. */
  product_id: z.string().uuid().optional(),
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

/**
 * 22.11.2026 (етап 8): накладна, сфотографована телефоном. Команда нічого не проводить і не створює карток:
 * каса кладе рядки у «вхідні», а людина на касі відкриває їх звичайною чернеткою приходу, перевіряє й проводить.
 * Ціни тут у гривнях, як у розпізнаванні; нечитана кількість чи ціна лишається відсутньою — каса підсвітить рядок.
 */
const invoiceRow = z.object({
  name: text(300).min(1),
  source_name: text(300).optional(),
  sku: text(100).optional(),
  barcode: text(64).optional(),
  brand_name: text(120).optional(),
  category_name: text(120).optional(),
  unit: text(20).optional(),
  qty: z.number().positive().max(1_000_000).optional(),
  purchase_price_uah: z.number().min(0).max(10_000_000).optional(),
})
export const INVOICE_DRAFT_MAX_ROWS = 300
export const invoiceDraftPayload = z.object({
  supplier_name: text(200).nullable().optional(),
  invoice_number: text(60).nullable().optional(),
  notes: text(500).nullable().optional(),
  author: text(120).nullable().optional(),
  rows: z.array(invoiceRow).min(1).max(INVOICE_DRAFT_MAX_ROWS),
}).strict()

/**
 * 22.11.2026 (етап 8): дозамовлення з вебу — до наявного відкритого замовлення можна лише додати позиції й примітку.
 * Команда не чекає в черзі (залежить від стану замовлення на касі) і не несе грошей, станів чи змін наявних рядків.
 */
export const orderAppendPayload = z.object({
  order_id: z.string().uuid(),
  author: text(120).nullable().optional(),
  comment: text(500).nullable().optional(),
  items: z.array(orderItem).min(1).max(60),
}).strict()

/** Скасування бланка з черги. Це не команда касі: сервер сам гасить бланк, якщо каса його ще не забрала. */
export const CANCEL_COMMAND = 'order.cancel'
export const CANCELED_IN_WEB = 'Скасовано у вебі'

export const createCommandSchema = z.discriminatedUnion('command', [
  z.object({ operation_id: z.string().uuid(), command: z.literal('order.cancel'), payload: z.object({ operation_id: z.string().uuid() }).strict() }).strict(),
  z.object({ operation_id: z.string().uuid(), command: z.literal('order.save'), payload: orderSavePayload }).strict(),
  z.object({ operation_id: z.string().uuid(), command: z.literal('invoice.draft'), payload: invoiceDraftPayload }).strict(),
  z.object({ operation_id: z.string().uuid(), command: z.literal('order.append'), payload: orderAppendPayload }).strict(),
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

/**
 * Скасувати бланк замовлення, який ще чекає касу. Атомарно: або бланк погашено, або каса вже його забрала —
 * тоді відмова, і людина знає, що замовлення створюється (скасувати його можна вже на касі).
 */
export async function cancelQueuedOrder(tenantId: string, operationId: string) {
  const { rowCount } = await pool.query(
    `UPDATE till_commands SET status = 'failed', error = $4, finished_at = now()
      WHERE tenant_id = $1 AND operation_id = $2 AND command = ANY($3::text[]) AND status = 'pending'`,
    // Скасувати з вебу можна лише бланк замовлення чи накладну; зміна PIN/пароля сюди не входить.
    [tenantId, operationId, [QUEUED_COMMAND, INVOICE_DRAFT_COMMAND], CANCELED_IN_WEB],
  )
  if (!rowCount) throw new AppError('CONFLICT', 'Каса вже забрала цей бланк або його вже немає в черзі. Якщо він уже на касі — приберіть його там.', 409)
  return { operation_id: operationId, status: 'canceled' }
}

export async function createCommand(tenantId: string, userId: string, input: z.infer<typeof createCommandSchema>) {
  if (input.command === CANCEL_COMMAND) return cancelQueuedOrder(tenantId, input.payload.operation_id)
  const online = (await tillStatus(tenantId)).online
  if (!online && !isQueued(input.command)) throw new AppError('TILL_OFFLINE', 'Каса зараз не в мережі. Зміну можна внести лише тоді, коли програма на касі увімкнена й має інтернет.', 409)
  const { rows } = await pool.query(
    `INSERT INTO till_commands (tenant_id, operation_id, command, payload, requested_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (tenant_id, operation_id) DO NOTHING
     RETURNING operation_id, status`,
    [tenantId, input.operation_id, input.command, JSON.stringify(input.payload), userId],
  )
  if (rows[0]) {
    // 22.11.2026: каса більше не опитує сервер щокілька секунд — про нову команду її будить сигнал.
    await wakeTill(tenantId)
    return { operation_id: rows[0].operation_id as string, status: rows[0].status as string, till_online: online }
  }
  // Повтор того самого запиту — та сама команда; інший вміст під тим самим номером — відмова.
  const existing = await pool.query('SELECT command, payload, status FROM till_commands WHERE tenant_id = $1 AND operation_id = $2', [tenantId, input.operation_id])
  const row = existing.rows[0]
  if (!row || row.command !== input.command || stable(row.payload) !== stable(input.payload))
    throw new AppError('CONFLICT', 'Номер операції вже використано для іншої зміни', 409)
  return { operation_id: input.operation_id, status: row.status as string, till_online: online }
}

/**
 * Замовлення з вебу, які ще чекають касу, і ті, яким каса відмовила за останню добу.
 * Людина надіслала бланк і пішла — відмова каси не має зникати мовчки. Прострочені тут же гасимо.
 */
export async function listWaitingOrders(tenantId: string, command: string = QUEUED_COMMAND) {
  await pool.query(
    `UPDATE till_commands SET status = 'expired', finished_at = now()
      WHERE tenant_id = $1 AND status = 'pending' AND created_at <= now() - ${PENDING_COMMAND_TTL_SQL}`,
    [tenantId],
  )
  const { rows } = await pool.query(
    `SELECT operation_id, payload, created_at, status, error FROM till_commands
      WHERE tenant_id = $1 AND command = $2
        AND (status IN ('pending', 'claimed') OR (status IN ('failed', 'expired') AND finished_at > now() - interval '24 hours'
             AND error IS DISTINCT FROM $3))
      ORDER BY created_at LIMIT 50`,
    [tenantId, command, CANCELED_IN_WEB],
  )
  return rows.map(row => {
    const payload = (row.payload ?? {}) as { customer_name?: string | null; customer_phone?: string | null; items?: unknown[]
      supplier_name?: string | null; invoice_number?: string | null; rows?: unknown[] }
    // Для накладної підпис — постачальник і номер; для замовлення — клієнт.
    const label = command === INVOICE_DRAFT_COMMAND
      ? [payload.supplier_name, payload.invoice_number ? '№ ' + payload.invoice_number : ''].filter(Boolean).join(' ')
      : String(payload.customer_name || payload.customer_phone || '')
    const lines = command === INVOICE_DRAFT_COMMAND ? payload.rows : payload.items
    return { operation_id: row.operation_id as string, created_at: new Date(row.created_at).toISOString(),
      customer: label, items: Array.isArray(lines) ? lines.length : 0,
      state: row.status === 'failed' ? 'failed' as const : row.status === 'expired' ? 'expired' as const : 'waiting' as const,
      error: row.status === 'failed' ? String(row.error ?? '') || null : null }
  })
}

/** Стан команди для вебу. Незабрану вчасно команду тут же позначаємо простроченою — каса її вже не візьме. */
export async function readCommand(tenantId: string, operationId: string) {
  if (!z.string().uuid().safeParse(operationId).success) throw new AppError('NOT_FOUND', 'Команду не знайдено', 404)
  await pool.query(
    `UPDATE till_commands SET status = 'expired', finished_at = now()
      WHERE tenant_id = $1 AND operation_id = $2 AND status = 'pending' AND created_at <= now() - ${PENDING_COMMAND_TTL_SQL}`,
    [tenantId, operationId],
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
/**
 * 27.11.2026: команду «замовлення скасували на сайті» розуміє лише нова збірка каси; стара відповіла б «невідома
 * команда», і скасування загубилось би. Тому віддаємо її тільки касі, яка сама сказала, що вміє (knowsSiteOrders);
 * до оновлення вона чекає в черзі (7 діб).
 */
export const SITE_COMMAND_SQL = `(command = 'order.site_cancel')`

export async function claimCommands(tenantId: string, deviceId: string, knowsSiteOrders = false) {
  if (!z.string().uuid().safeParse(deviceId).success) throw new AppError('VALIDATION_ERROR', 'Некоректний ідентифікатор каси', 422)
  await pool.query(
    `INSERT INTO till_presence (tenant_id, device_id, seen_at) VALUES ($1, $2, now())
     ON CONFLICT (tenant_id) DO UPDATE SET device_id = EXCLUDED.device_id, seen_at = now()`,
    [tenantId, deviceId],
  )
  const { rows } = await pool.query(
    `UPDATE till_commands SET status = 'claimed', device_id = $2, claimed_at = now()
      WHERE id IN (SELECT id FROM till_commands WHERE tenant_id = $1 AND status = 'pending'
                     AND created_at > now() - ${PENDING_COMMAND_TTL_SQL}
                     AND ($3::boolean OR NOT ${SITE_COMMAND_SQL})
                   ORDER BY created_at LIMIT 5 FOR UPDATE SKIP LOCKED)
      RETURNING id, operation_id, command, payload, requested_by, created_at`,
    [tenantId, deviceId, knowsSiteOrders],
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

/** Передати касі новий хеш PIN чи пароля працівника (див. STAFF_SECRET_COMMAND). Сам секрет сюди не потрапляє. */
export async function queueStaffSecret(tenantId: string, requestedBy: string, userId: string, kind: 'pin' | 'password', hash: string) {
  if (!/^pbkdf2-sha512\$\d+\$[^$]+\$[^$]+$/.test(hash)) throw new AppError('VALIDATION_ERROR', 'Некоректний хеш', 422)
  await pool.query(
    `INSERT INTO till_commands (tenant_id, operation_id, command, payload, requested_by) VALUES ($1, gen_random_uuid(), $2, $3::jsonb, $4)`,
    [tenantId, STAFF_SECRET_COMMAND, JSON.stringify({ user_id: userId, kind, hash }), requestedBy],
  )
  await wakeTill(tenantId)
}
