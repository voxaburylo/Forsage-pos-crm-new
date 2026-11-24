import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { SITE_ORDER_AUTHOR } from './tillCommandService.js'
import { wakeTill } from './tillWake.js'

/**
 * Сайт магазину (рішення власника 24.11.2026).
 * Сайт — окрема програма. Він читає каталог із хмарної копії (а не з головного ПК) і передає замовлення сюди;
 * замовлення йде на касу тим самим шляхом, що бланк із телефона (команда order.save), грошей у ньому немає.
 * Усім керує власник у розділі «Сайт». Закупівельна ціна сайту не віддається ніколи; ціна сайту — не нижче закупки.
 */
export const SITE_KEY_PATTERN = /^fsk_[A-Za-z0-9_-]{43}$/
export const SITE_PAGE_MAX = 500
/** Поки каса не забрала замовлення сайту — воно чекає до 7 днів (вихідні, свята). */
export const SITE_ORDER_TTL_SECONDS = 7 * 24 * 60 * 60

const line = (max: number) => z.string().trim().max(max)
export const siteSettingsSchema = z.object({
  /** Показувати ціни. Вимкнено — на сайті «ціну уточнюйте». */
  show_prices: z.boolean(),
  /** Наявність: hidden — не показувати; flag — «є / немає»; qty — кількість штук. */
  stock_mode: z.enum(['hidden', 'flag', 'qty']),
  /** Віддавати сайту лише товари, які є на складі. */
  only_in_stock: z.boolean(),
  /** Розділи каталогу, приховані від сайту (разом із вкладеними). */
  hidden_category_ids: z.array(z.string().uuid()).max(500),
  /** Ціна сайту відносно ціни продажу, у відсотках: −10 = дешевше на 10%, 5 = дорожче на 5%. Не нижче закупки. */
  price_change_pct: z.number().min(-50).max(100),
  /** Приймати замовлення із сайту. */
  accept_orders: z.boolean(),
  /** Найменша сума замовлення, у копійках. 0 — без обмеження. */
  min_order_kopecks: z.number().int().min(0).max(100_000_000),
  title: line(120), phone: line(60), address: line(300), working_hours: line(300),
  banner_text: line(300), about: line(4000), delivery_text: line(4000), payment_text: line(4000),
}).strict()
export type SiteSettings = z.infer<typeof siteSettingsSchema>

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  show_prices: true, stock_mode: 'flag', only_in_stock: false, hidden_category_ids: [], price_change_pct: 0,
  accept_orders: true, min_order_kopecks: 0,
  title: '', phone: '', address: '', working_hours: '', banner_text: '', about: '', delivery_text: '', payment_text: '',
}

/** Збережені налаштування можуть бути старішими за код: невідоме відкидаємо, відсутнє беремо типове. */
export function readSiteSettings(raw: unknown): SiteSettings {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const merged: Record<string, unknown> = { ...DEFAULT_SITE_SETTINGS }
  for (const key of Object.keys(DEFAULT_SITE_SETTINGS)) {
    const field = (siteSettingsSchema.shape as Record<string, z.ZodTypeAny>)[key]
    const parsed = field.safeParse(source[key])
    if (parsed.success) merged[key] = parsed.data
  }
  return merged as SiteSettings
}

/** Ціна для сайту в копійках: зміна у відсотках, округлення вгору до гривні, але НІКОЛИ не нижче закупки. 0 — ціни немає. */
export function sitePrice(retail: number, purchase: number, changePct: number): number {
  if (!(retail > 0)) return 0
  const changed = Math.ceil((retail * (100 + changePct)) / 100 / 100) * 100
  return Math.max(changed, purchase > 0 ? purchase : 0)
}

export function newSiteKey(): string {
  return 'fsk_' + randomBytes(32).toString('base64url')
}
export function siteKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

// ── Власник ─────────────────────────────────────────────────────────────────────────────────────

export async function readSiteAdmin(tenantId: string) {
  const row = (await pool.query(
    'SELECT enabled, settings, api_key_hint, key_created_at, updated_at FROM site_settings WHERE tenant_id = $1', [tenantId])).rows[0]
  return {
    enabled: Boolean(row?.enabled),
    settings: readSiteSettings(row?.settings),
    key_hint: row?.api_key_hint ? String(row.api_key_hint) : null,
    key_created_at: row?.key_created_at ? new Date(row.key_created_at).toISOString() : null,
    updated_at: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
  }
}

export const siteAdminUpdateSchema = z.object({ enabled: z.boolean(), settings: siteSettingsSchema }).strict()

export async function saveSiteAdmin(tenantId: string, userId: string, input: z.infer<typeof siteAdminUpdateSchema>) {
  const settings = { ...input.settings, hidden_category_ids: [...new Set(input.settings.hidden_category_ids)] }
  await pool.query(
    `INSERT INTO site_settings (tenant_id, enabled, settings, updated_by, updated_at) VALUES ($1, $2, $3::jsonb, $4, now())
     ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [tenantId, input.enabled, JSON.stringify(settings), userId],
  )
  return readSiteAdmin(tenantId)
}

/** Новий ключ сайту. Сам ключ показується один раз; старий одразу перестає діяти. */
export async function issueSiteKey(tenantId: string, userId: string) {
  const key = newSiteKey()
  await pool.query(
    `INSERT INTO site_settings (tenant_id, api_key_hash, api_key_hint, key_created_at, updated_by, updated_at)
     VALUES ($1, $2, $3, now(), $4, now())
     ON CONFLICT (tenant_id) DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash, api_key_hint = EXCLUDED.api_key_hint,
       key_created_at = now(), updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [tenantId, siteKeyHash(key), '…' + key.slice(-4), userId],
  )
  return { key, ...(await readSiteAdmin(tenantId)) }
}

export async function revokeSiteKey(tenantId: string, userId: string) {
  await pool.query('UPDATE site_settings SET api_key_hash = NULL, api_key_hint = NULL, key_created_at = NULL, updated_by = $2, updated_at = now() WHERE tenant_id = $1', [tenantId, userId])
  return readSiteAdmin(tenantId)
}

/** Усі розділи каталогу — власник відмічає, які сховати від сайту. */
export async function listSiteAdminCategories(tenantId: string) {
  const { rows } = await pool.query('SELECT id, parent_id, name FROM categories WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY sort_order, name', [tenantId])
  return rows.map((row: any) => ({ id: row.id as string, parent_id: (row.parent_id ?? null) as string | null, name: String(row.name) }))
}

const ORDER_STATE: Record<string, 'waiting' | 'in_program' | 'refused' | 'expired'> = { pending: 'waiting', claimed: 'waiting', done: 'in_program', failed: 'refused', expired: 'expired' }

/** Замовлення із сайту для власника: що прийшло і чи потрапило в програму. */
export async function listSiteOrders(tenantId: string) {
  const { rows } = await pool.query(
    `SELECT o.id, o.external_id, o.customer_name, o.customer_phone, o.delivery, o.comment, o.items, o.total_amount, o.created_at,
            c.status, c.error, c.result
       FROM site_orders o LEFT JOIN till_commands c ON c.tenant_id = o.tenant_id AND c.operation_id = o.id
      WHERE o.tenant_id = $1 ORDER BY o.created_at DESC LIMIT 100`,
    [tenantId],
  )
  return rows.map(orderRow)
}

function orderRow(row: any) {
  const result = (row.result ?? {}) as { order_number?: unknown }
  return {
    id: row.id as string, external_id: row.external_id as string,
    customer_name: String(row.customer_name ?? ''), customer_phone: String(row.customer_phone ?? ''),
    delivery: row.delivery ? String(row.delivery) : null, comment: row.comment ? String(row.comment) : null,
    items: Array.isArray(row.items) ? row.items as Array<{ product_id: string; name: string; sku: string | null; qty: number; price: number }> : [],
    total_amount: Number(row.total_amount) || 0,
    created_at: new Date(row.created_at).toISOString(),
    state: ORDER_STATE[String(row.status ?? 'pending')] ?? 'waiting',
    order_number: result.order_number == null ? null : String(result.order_number),
    error: row.status === 'failed' && row.error ? String(row.error) : null,
  }
}

// ── Сайт ────────────────────────────────────────────────────────────────────────────────────────

export interface SiteAccess { tenant_id: string; settings: SiteSettings; updated_at: string; owner_id: string | null }

/** Ключ сайту → магазин. Невідомий ключ і вимкнений сайт — різні відповіді: розробник сайту має розуміти причину. */
export async function siteAccess(key: unknown): Promise<SiteAccess> {
  if (typeof key !== 'string' || !SITE_KEY_PATTERN.test(key)) throw new AppError('SITE_KEY_INVALID', 'Невірний ключ сайту', 401)
  const row = (await pool.query('SELECT tenant_id, enabled, settings, updated_at, updated_by FROM site_settings WHERE api_key_hash = $1', [siteKeyHash(key)])).rows[0]
  if (!row) throw new AppError('SITE_KEY_INVALID', 'Невірний ключ сайту', 401)
  if (!row.enabled) throw new AppError('SITE_DISABLED', 'Сайт вимкнено власником у програмі', 403)
  return { tenant_id: row.tenant_id, settings: readSiteSettings(row.settings), updated_at: new Date(row.updated_at).toISOString(), owner_id: row.updated_by ?? null }
}

export async function siteInfo(access: SiteAccess) {
  const shop = (await pool.query('SELECT shop_name, phone, shop_address FROM shop_settings WHERE tenant_id = $1 LIMIT 1', [access.tenant_id])).rows[0]
  const s = access.settings
  return {
    title: s.title || shop?.shop_name || '', phone: s.phone || shop?.phone || '', address: s.address || shop?.shop_address || '',
    working_hours: s.working_hours, banner_text: s.banner_text, about: s.about, delivery_text: s.delivery_text, payment_text: s.payment_text,
    show_prices: s.show_prices, stock_mode: s.stock_mode, accept_orders: s.accept_orders, min_order_amount: s.min_order_kopecks,
    currency: 'UAH', price_unit: 'kopecks',
    /** Змінилося — сайту варто перечитати каталог повністю: могли сховати розділ чи змінити ціни. */
    settings_updated_at: access.updated_at,
  }
}

/** Приховані розділи разом з усіма вкладеними. */
const HIDDEN_CATEGORIES_SQL = `WITH RECURSIVE hidden AS (
    SELECT id FROM categories WHERE tenant_id = $1 AND id = ANY($2::uuid[])
    UNION SELECT c.id FROM categories c JOIN hidden h ON c.parent_id = h.id WHERE c.tenant_id = $1)`

export async function siteCategories(access: SiteAccess) {
  const { rows } = await pool.query(
    `${HIDDEN_CATEGORIES_SQL}
     SELECT c.id, c.parent_id, c.name, c.sort_order FROM categories c
      WHERE c.tenant_id = $1 AND c.deleted_at IS NULL AND c.id NOT IN (SELECT id FROM hidden)
      ORDER BY c.sort_order, c.name`,
    [access.tenant_id, access.settings.hidden_category_ids],
  )
  return rows.map((row: any) => ({ id: row.id as string, parent_id: (row.parent_id ?? null) as string | null, name: String(row.name), sort_order: Number(row.sort_order) || 0 }))
}

/** Чи видно товар сайту: діючий, не послуга, не в прихованому розділі, а за «лише в наявності» — ще й є на складі. */
const VISIBLE_SQL = `(p.deleted_at IS NULL AND p.is_active AND NOT COALESCE(p.is_service, false)
  AND (p.category_id IS NULL OR p.category_id NOT IN (SELECT id FROM hidden))
  AND (NOT $3::boolean OR p.qty_on_hand > 0))`
const PRODUCT_COLUMNS = `p.id, p.sku, p.name, p.barcode, p.unit, p.category_id, p.oem_number, p.photo_url, p.retail_price, p.purchase_price,
  p.qty_on_hand::float8 AS qty, p.updated_at, b.name AS brand, ${VISIBLE_SQL} AS visible`

function siteProduct(row: any, settings: SiteSettings) {
  if (!row.visible) return { id: row.id as string, removed: true as const, updated_at: new Date(row.updated_at).toISOString() }
  const price = sitePrice(Number(row.retail_price) || 0, Number(row.purchase_price) || 0, settings.price_change_pct)
  const qty = Number(row.qty) || 0
  return {
    id: row.id as string, sku: row.sku ? String(row.sku) : null, name: String(row.name), brand: row.brand ? String(row.brand) : null,
    category_id: (row.category_id ?? null) as string | null, barcode: row.barcode ? String(row.barcode) : null,
    oem_number: row.oem_number ? String(row.oem_number) : null, unit: row.unit ? String(row.unit) : null,
    photo_url: typeof row.photo_url === 'string' && /^https:\/\//.test(row.photo_url) ? row.photo_url : null,
    ...(settings.show_prices ? { price: price > 0 ? price : null } : {}),
    ...(settings.stock_mode === 'flag' ? { in_stock: qty > 0 } : settings.stock_mode === 'qty' ? { in_stock: qty > 0, qty: Math.max(qty, 0) } : {}),
    updated_at: new Date(row.updated_at).toISOString(),
  }
}

export const siteProductsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(SITE_PAGE_MAX).default(200),
  /** Лише картки, змінені після цього часу; серед них будуть і зняті з сайту (removed: true). */
  updated_since: z.string().datetime({ offset: true }).optional(),
  /** Продовження: значення next_cursor з попередньої відповіді. */
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional(),
  category_id: z.string().uuid().optional(),
})

function readCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
    if (!at || Number.isNaN(Date.parse(at)) || !z.string().uuid().safeParse(id).success) throw new Error('bad')
    return { at, id }
  } catch { throw new AppError('VALIDATION_ERROR', 'Некоректний cursor', 422) }
}

/**
 * Каталог сторінками, у порядку оновлення картки. Без updated_since — лише видимі товари (повне завантаження);
 * з updated_since — усе змінене, а зняте з сайту позначено removed: true (щоб сайт прибрав це в себе).
 */
export async function siteProducts(access: SiteAccess, rawQuery: unknown) {
  const parsed = siteProductsQuery.safeParse(rawQuery)
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Перевірте параметри: limit 1–500, updated_since у форматі ISO, cursor з попередньої відповіді', 422)
  const query = parsed.data, s = access.settings
  const after = readCursor(query.cursor)
  const delta = Boolean(query.updated_since)
  const { rows } = await pool.query(
    `${HIDDEN_CATEGORIES_SQL}
     SELECT ${PRODUCT_COLUMNS}, to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
       FROM products p LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1
        AND ($4::timestamptz IS NULL OR p.updated_at > $4::timestamptz)
        AND ($5::timestamptz IS NULL OR (p.updated_at, p.id) > ($5::timestamptz, $6::uuid))
        AND ($7::uuid IS NULL OR p.category_id = $7::uuid)
        AND ($8::boolean OR ${VISIBLE_SQL})
      ORDER BY p.updated_at, p.id LIMIT $9`,
    [access.tenant_id, s.hidden_category_ids, s.only_in_stock, query.updated_since ?? null, after?.at ?? null, after?.id ?? null,
      query.category_id ?? null, delta, query.limit + 1],
  )
  const page = rows.slice(0, query.limit)
  const last = page[page.length - 1]
  return {
    items: page.map((row: any) => siteProduct(row, s)),
    next_cursor: rows.length > query.limit && last ? Buffer.from(`${last.cursor_at}|${last.id}`).toString('base64url') : null,
  }
}

export async function siteProductById(access: SiteAccess, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new AppError('NOT_FOUND', 'Товар не знайдено', 404)
  const s = access.settings
  const row = (await pool.query(
    `${HIDDEN_CATEGORIES_SQL}
     SELECT ${PRODUCT_COLUMNS} FROM products p LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1 AND p.id = $4`,
    [access.tenant_id, s.hidden_category_ids, s.only_in_stock, id],
  )).rows[0]
  if (!row?.visible) throw new AppError('NOT_FOUND', 'Товар не знайдено', 404)
  return siteProduct(row, s)
}

export const siteOrderSchema = z.object({
  /** Номер замовлення на сайті. Повтор з тим самим номером не створює другого замовлення. */
  external_id: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  customer_name: z.string().trim().min(1).max(120),
  customer_phone: z.string().trim().min(10).max(30),
  delivery: z.string().trim().max(300).optional(),
  comment: z.string().trim().max(500).optional(),
  items: z.array(z.object({
    product_id: z.string().uuid(),
    qty: z.number().positive().max(100_000).refine(value => Math.round(value * 1000) === value * 1000),
  }).strict()).min(1).max(60),
}).strict()

/** Телефон: лише цифри, 10–12 знаків (як у картці клієнта на касі). */
export function sitePhone(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 12) throw new AppError('VALIDATION_ERROR', 'Перевірте телефон: потрібно 10–12 цифр', 422)
  return digits
}

/**
 * Замовлення із сайту. Ціни рахує сервер (сайт цін не передає), замовлення лягає в чергу каси командою order.save —
 * каса створить його у своїй базі. Грошей тут немає: оплату приймає каса.
 */
export async function createSiteOrder(access: SiteAccess, raw: unknown) {
  const s = access.settings
  if (!s.accept_orders) throw new AppError('SITE_ORDERS_OFF', 'Прийом замовлень із сайту вимкнено', 409)
  const parsed = siteOrderSchema.safeParse(raw)
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Перевірте замовлення: external_id, customer_name, customer_phone, items[{product_id, qty}] (1–60 позицій)', 422)
  const input = parsed.data
  const phone = sitePhone(input.customer_phone)
  if (!access.owner_id) throw new AppError('SITE_NOT_READY', 'Сайт ще не налаштовано в програмі', 409)

  const repeat = await findOrder(access.tenant_id, input.external_id)
  if (repeat) return repeat

  const wanted = new Map<string, number>()
  for (const item of input.items) wanted.set(item.product_id, Math.round(((wanted.get(item.product_id) ?? 0) + item.qty) * 1000) / 1000)
  const { rows } = await pool.query(
    `${HIDDEN_CATEGORIES_SQL}
     SELECT ${PRODUCT_COLUMNS} FROM products p LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1 AND p.id = ANY($4::uuid[])`,
    [access.tenant_id, s.hidden_category_ids, s.only_in_stock, [...wanted.keys()]],
  )
  const cards = new Map<string, any>(rows.filter((row: any) => row.visible).map((row: any) => [row.id, row]))
  const missing = [...wanted.keys()].filter(id => !cards.has(id))
  if (missing.length) throw new AppError('SITE_PRODUCT_UNAVAILABLE', 'Цих товарів уже немає на сайті: ' + missing.join(', '), 409, { product_ids: missing })

  const items = [...wanted].map(([id, qty]) => {
    const card = cards.get(id)
    return { product_id: id, name: String(card.name), sku: card.sku ? String(card.sku) : null, qty,
      price: sitePrice(Number(card.retail_price) || 0, Number(card.purchase_price) || 0, s.price_change_pct) }
  })
  const total = items.reduce((sum, item) => sum + Math.round(item.price * item.qty), 0)
  if (s.min_order_kopecks > 0 && total < s.min_order_kopecks)
    throw new AppError('SITE_ORDER_TOO_SMALL', 'Сума замовлення менша за найменшу', 409, { min_order_amount: s.min_order_kopecks, total_amount: total })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const saved = await client.query(
      `INSERT INTO site_orders (tenant_id, external_id, customer_name, customer_phone, delivery, comment, items, total_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) ON CONFLICT (tenant_id, external_id) DO NOTHING RETURNING id`,
      [access.tenant_id, input.external_id, input.customer_name, phone, input.delivery || null, input.comment || null, JSON.stringify(items), total],
    )
    if (saved.rows[0]) {
      const note = ['Замовлення із сайту № ' + input.external_id, input.delivery ? 'Доставка: ' + input.delivery : '', input.comment ?? ''].filter(Boolean).join('. ').slice(0, 1000)
      const payload = { customer_phone: phone, customer_name: input.customer_name, comment: note, author: SITE_ORDER_AUTHOR,
        items: items.map(item => ({ name: item.name.slice(0, 300), sku: item.sku ? item.sku.slice(0, 100) : null, qty: item.qty, sell_price: item.price, product_id: item.product_id })) }
      await client.query(
        `INSERT INTO till_commands (tenant_id, operation_id, command, payload, requested_by) VALUES ($1, $2, 'order.save', $3::jsonb, $4)`,
        [access.tenant_id, saved.rows[0].id, JSON.stringify(payload), access.owner_id],
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
  // Сигнал касі — лише прискорювач; без нього каса забере замовлення сама за рідким опитуванням.
  await wakeTill(access.tenant_id).catch(() => undefined)
  const order = await findOrder(access.tenant_id, input.external_id)
  if (!order) throw new AppError('INTERNAL_ERROR', 'Замовлення не збережено', 500)
  return order
}

async function findOrder(tenantId: string, externalId: string) {
  const row = (await pool.query(
    `SELECT o.id, o.external_id, o.customer_name, o.customer_phone, o.delivery, o.comment, o.items, o.total_amount, o.created_at,
            c.status, c.error, c.result
       FROM site_orders o LEFT JOIN till_commands c ON c.tenant_id = o.tenant_id AND c.operation_id = o.id
      WHERE o.tenant_id = $1 AND o.external_id = $2`,
    [tenantId, externalId],
  )).rows[0]
  return row ? publicOrder(orderRow(row)) : null
}

/** Що бачить сайт про своє замовлення: без внутрішніх причин відмови каси. */
function publicOrder(order: ReturnType<typeof orderRow>) {
  return { id: order.id, external_id: order.external_id, state: order.state, order_number: order.order_number,
    items: order.items, total_amount: order.total_amount, created_at: order.created_at }
}

export async function siteOrderStatus(access: SiteAccess, externalId: string) {
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(externalId)) throw new AppError('NOT_FOUND', 'Замовлення не знайдено', 404)
  const order = await findOrder(access.tenant_id, externalId)
  if (!order) throw new AppError('NOT_FOUND', 'Замовлення не знайдено', 404)
  return order
}
