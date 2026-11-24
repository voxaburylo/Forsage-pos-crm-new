import { z } from 'zod'
import { pool } from '../db/pg.js'
import { applyMarkup, roundingFromSettings, type MarkupRule } from '../lib/markup.js'
import { AppError } from '../middleware/errorHandler.js'

/**
 * Постачальники з API (рішення власника 24.11.2026). Перший — Омега (public.omega.page).
 * Товари постачальника — «чернетка під замовлення»: окрема таблиця supplier_offers, у номенклатуру складу не йдуть.
 * Ключ постачальника читає лише сервер; назовні — тільки «ключ є, закінчується на …».
 * Закупка постачальника видна тим, кому дозволено (власник, адмін, менеджер), а сайту — ніколи.
 */
export const OMEGA_BASE = 'https://public.omega.page/public/api/v1.0'
export const OMEGA_PAGE_SIZE = 1000
/** Скільки сторінок прайсу забирати за один виклик планувальника (виклик живе до 5 хв; сторінка ~20 с). */
export const PAGES_PER_RUN = 8
/** Повний прохід прайсу не частіше, ніж раз на годину. */
export const FULL_PASS_EVERY_MS = 60 * 60_000

export const code = (value: unknown) => String(value ?? '').normalize('NFKC').toLocaleUpperCase('uk-UA').replace(/[^A-ZА-ЯІЇЄҐ0-9]/g, '')
const kopecks = (uah: unknown) => { const n = Number(uah); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0 }
/** «Львів 1» → «Львів»; «Київ_Правий_Південь» → «Київ». */
export const warehouseCity = (name: string) => name.split(/[\s_]+/)[0]?.replace(/\d+$/, '') || null

export interface OmegaItem { ProductId?: unknown; Card?: unknown; Number?: unknown; BrandDescription?: unknown; Description?: unknown; DescriptionUkr?: unknown
  Price?: unknown; BarCode?: unknown; ImageUrl?: unknown; Rests?: Array<{ Key?: unknown; Value?: unknown }> }
export interface OfferRow { external_id: string; number: string; number_code: string; brand: string | null; name: string; barcode: string | null; image_url: string | null
  purchase_price: number; retail_price: number; stock: Array<{ w: string; q: number }>; total_qty: number }

/** Залишок Омеги — рядок: «1», «>10», «10+», «4,000». Невідоме — 0. */
export function restQty(value: unknown): number {
  const match = String(value ?? '').replace(',', '.').match(/\d+(?:\.\d+)?/)
  return match ? Math.max(0, Math.floor(Number(match[0]))) : 0
}

/** Рядок прайсу Омеги → товар під замовлення. Без артикула, назви чи ціни — пропускаємо. */
export function omegaOffer(item: OmegaItem, retail: (purchase: number) => number): OfferRow | null {
  const external = String(item.ProductId ?? item.Card ?? '').trim()
  const number = String(item.Number ?? '').trim().slice(0, 120)
  const name = String(item.DescriptionUkr || item.Description || '').trim().slice(0, 400)
  const purchase = kopecks(item.Price)
  if (!external || !number || !code(number) || !name || !purchase) return null
  const stock = (item.Rests ?? []).map(rest => ({ w: String(rest.Key ?? '').trim().slice(0, 120), q: restQty(rest.Value) })).filter(rest => rest.w && rest.q > 0)
  const image = typeof item.ImageUrl === 'string' && /^https:\/\//.test(item.ImageUrl) ? item.ImageUrl.slice(0, 600) : null
  const barcode = String(item.BarCode ?? '').replace(/\s/g, '').slice(0, 64) || null
  return { external_id: external.slice(0, 80), number, number_code: code(number).slice(0, 120), brand: String(item.BrandDescription ?? '').trim().slice(0, 120) || null, name,
    barcode, image_url: image, purchase_price: purchase, retail_price: retail(purchase), stock, total_qty: stock.reduce((sum, rest) => sum + rest.q, 0) }
}

export interface OmegaDeps { fetchImpl?: typeof fetch }

async function omegaCall<T>(path: string, key: string, body: Record<string, unknown>, deps: OmegaDeps = {}, timeoutMs = 120_000): Promise<T> {
  let response: Response
  try {
    response = await (deps.fetchImpl ?? fetch)(OMEGA_BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, Key: key }), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
  } catch { throw new AppError('SUPPLIER_UNREACHABLE', 'Омега не відповіла. Спробуйте пізніше.', 502) }
  const json = await response.json().then(value => value as T & { Success?: boolean; Errors?: Array<{ Description?: string; Error?: string }> }, () => null)
  if (!response.ok || !json) throw new AppError('SUPPLIER_REFUSED', `Омега відповіла з помилкою (код ${response.status}). Перевірте ключ.`, 502)
  if (json.Success === false) throw new AppError('SUPPLIER_REFUSED', 'Омега відмовила: ' + (json.Errors?.map(error => error.Description || error.Error).filter(Boolean).join('; ').slice(0, 200) || 'невідома причина'), 502)
  return json
}

export async function omegaAccount(key: string, deps: OmegaDeps = {}) {
  const answer = await omegaCall<{ Data?: { Access?: string; Subscription?: string } }>('/profile/account', key, {}, deps, 20_000)
  return { access: String(answer.Data?.Access ?? ''), subscription: String(answer.Data?.Subscription ?? '') }
}

export async function omegaPage(key: string, page: number, deps: OmegaDeps = {}) {
  const answer = await omegaCall<{ Result?: OmegaItem[]; Total?: number }>('/product/pricelist/paged', key, { From: page, Count: OMEGA_PAGE_SIZE, AddSupplierRests: false, IsPrepay: false }, deps)
  return { items: Array.isArray(answer.Result) ? answer.Result : [], total: Number(answer.Total) || 0 }
}

// ── Налаштування (власник) ─────────────────────────────────────────────────────────────────────

const hint = (key: string) => '…' + key.slice(-4)

export async function listConnections(tenantId: string) {
  const { rows } = await pool.query(
    `SELECT c.id, c.provider, c.name, c.api_key, c.enabled, c.supplier_id, c.sync_page, c.sync_started_at, c.last_full_sync_at, c.last_error, c.total_offers, c.updated_at,
            (SELECT count(*) FROM supplier_offers o WHERE o.connection_id = c.id)::int AS offers,
            (SELECT count(*) FROM supplier_offers o WHERE o.connection_id = c.id AND o.product_id IS NOT NULL)::int AS linked
       FROM supplier_api_connections c WHERE c.tenant_id = $1 ORDER BY c.created_at`, [tenantId])
  const warehouses = (await pool.query('SELECT id, connection_id, code, name, city, days_to_ship, is_active FROM supplier_warehouses WHERE tenant_id = $1 ORDER BY name', [tenantId])).rows
  return rows.map((row: any) => ({
    id: row.id, provider: row.provider, name: row.name, key_hint: hint(String(row.api_key)), enabled: row.enabled, supplier_id: row.supplier_id,
    syncing: Boolean(row.sync_started_at), sync_page: row.sync_page, last_full_sync_at: row.last_full_sync_at ? new Date(row.last_full_sync_at).toISOString() : null,
    last_error: row.last_error, total_offers: row.total_offers, offers: row.offers, linked: row.linked,
    warehouses: warehouses.filter((w: any) => w.connection_id === row.id).map((w: any) => ({ id: w.id, code: w.code, name: w.name, city: w.city, days_to_ship: w.days_to_ship, is_active: w.is_active })),
  }))
}

export const connectionSchema = z.object({
  provider: z.literal('omega'),
  name: z.string().trim().min(1).max(80).default('Омега'),
  api_key: z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9_-]+$/).optional(),
  enabled: z.boolean().default(true),
  supplier_id: z.string().uuid().nullable().optional(),
}).strict()

/** Зберегти підключення. Ключ перевіряємо в Омеги ДО запису — хибний ключ не затре робочий. */
export async function saveConnection(tenantId: string, userId: string, input: z.infer<typeof connectionSchema>, deps: OmegaDeps = {}) {
  if (input.api_key) {
    const account = await omegaAccount(input.api_key, deps)
    if (!account.access) throw new AppError('SUPPLIER_REFUSED', 'Омега не прийняла ключ', 422)
  }
  const existing = (await pool.query('SELECT id FROM supplier_api_connections WHERE tenant_id = $1 AND provider = $2', [tenantId, input.provider])).rows[0]
  if (!existing && !input.api_key) throw new AppError('VALIDATION_ERROR', 'Вкажіть ключ API', 422)
  if (existing) {
    await pool.query(`UPDATE supplier_api_connections SET name = $3, enabled = $4, supplier_id = $5, api_key = COALESCE($6, api_key), last_error = CASE WHEN $6 IS NULL THEN last_error END, updated_at = now()
                       WHERE tenant_id = $1 AND id = $2`, [tenantId, existing.id, input.name, input.enabled, input.supplier_id ?? null, input.api_key ?? null])
  } else {
    await pool.query(`INSERT INTO supplier_api_connections (tenant_id, provider, name, api_key, enabled, supplier_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, input.provider, input.name, input.api_key, input.enabled, input.supplier_id ?? null, userId])
  }
  return listConnections(tenantId)
}

export async function removeConnection(tenantId: string, id: string) {
  await pool.query('DELETE FROM supplier_api_connections WHERE tenant_id = $1 AND id = $2', [tenantId, id])
  return listConnections(tenantId)
}

export const warehouseSchema = z.object({ days_to_ship: z.number().int().min(0).max(60).nullable(), is_active: z.boolean() }).strict()
export async function saveWarehouse(tenantId: string, id: string, input: z.infer<typeof warehouseSchema>) {
  const { rowCount } = await pool.query('UPDATE supplier_warehouses SET days_to_ship = $3, is_active = $4 WHERE tenant_id = $1 AND id = $2', [tenantId, id, input.days_to_ship, input.is_active])
  if (!rowCount) throw new AppError('NOT_FOUND', 'Склад не знайдено', 404)
  // Сайт бачить зміну строку за часом оновлення товарів цього постачальника.
  await pool.query(`UPDATE supplier_offers o SET updated_at = now() FROM supplier_warehouses w
     WHERE w.id = $2 AND w.tenant_id = $1 AND o.connection_id = w.connection_id AND o.stock @> jsonb_build_array(jsonb_build_object('w', w.code))`, [tenantId, id])
  return listConnections(tenantId)
}

// ── Завантаження прайсу ────────────────────────────────────────────────────────────────────────

async function retailFor(tenantId: string) {
  const settings = (await pool.query('SELECT markup_rules, price_rounding_enabled, price_rounding_step, price_rounding_dir FROM shop_settings WHERE tenant_id = $1 LIMIT 1', [tenantId])).rows[0]
  const rules = (Array.isArray(settings?.markup_rules) ? settings.markup_rules : []) as MarkupRule[]
  const rounding = roundingFromSettings(settings)
  // Ніколи не нижче закупки (правило власника): без правил — +30%.
  return (purchase: number) => Math.max(purchase, applyMarkup(purchase, rules, 30, rounding))
}

async function writeOffers(tenantId: string, connectionId: string, offers: OfferRow[]) {
  if (!offers.length) return
  await pool.query(
    `INSERT INTO supplier_offers (tenant_id, connection_id, external_id, number, number_code, brand, name, barcode, image_url, purchase_price, retail_price, stock, total_qty, seen_at, updated_at)
     SELECT $1, $2, x.external_id, x.number, x.number_code, x.brand, x.name, x.barcode, x.image_url, x.purchase_price, x.retail_price, x.stock, x.total_qty, now(), now()
       FROM jsonb_to_recordset($3::jsonb) AS x(external_id text, number text, number_code text, brand text, name text, barcode text, image_url text,
            purchase_price bigint, retail_price bigint, stock jsonb, total_qty int)
     ON CONFLICT (connection_id, external_id) DO UPDATE SET
       number = EXCLUDED.number, number_code = EXCLUDED.number_code, brand = EXCLUDED.brand, name = EXCLUDED.name, barcode = EXCLUDED.barcode,
       image_url = COALESCE(EXCLUDED.image_url, supplier_offers.image_url), purchase_price = EXCLUDED.purchase_price, retail_price = EXCLUDED.retail_price,
       stock = EXCLUDED.stock, total_qty = EXCLUDED.total_qty, seen_at = now(),
       -- Час змінюємо лише коли змінилось те, що бачить сайт: так сайт забирає справжні зміни, а не весь прайс щогодини.
       updated_at = CASE WHEN supplier_offers.retail_price IS DISTINCT FROM EXCLUDED.retail_price OR supplier_offers.stock IS DISTINCT FROM EXCLUDED.stock
                           OR supplier_offers.name IS DISTINCT FROM EXCLUDED.name THEN now() ELSE supplier_offers.updated_at END`,
    [tenantId, connectionId, JSON.stringify(offers)],
  )
  const warehouses = [...new Set(offers.flatMap(offer => offer.stock.map(rest => rest.w)))]
  if (warehouses.length) await pool.query(
    `INSERT INTO supplier_warehouses (tenant_id, connection_id, code, name, city)
     SELECT $1, $2, w, w, ($4::text[])[i] FROM unnest($3::text[]) WITH ORDINALITY AS t(w, i) ON CONFLICT (connection_id, code) DO NOTHING`,
    [tenantId, connectionId, warehouses, warehouses.map(warehouseCity)])
}

/**
 * Привʼязати товари постачальника до наших карток: той самий артикул (без знаків) і бренд, або той самий штрихкод.
 * Лише однозначний збіг; товар постачальника карткою складу не стає.
 */
export async function linkOffers(tenantId: string, connectionId: string) {
  await pool.query(
    `WITH ours AS (
       SELECT p.id, upper(regexp_replace(p.sku, '[^A-Za-zА-Яа-яІЇЄҐіїєґ0-9]', '', 'g')) AS sku_code, upper(regexp_replace(coalesce(b.name, ''), '[^A-Za-zА-Яа-яІЇЄҐіїєґ0-9]', '', 'g')) AS brand_code
         FROM products p LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
        WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.is_active),
     by_sku AS (
       SELECT o.external_id, min(ours.id::text)::uuid AS product_id, count(*) AS n
         FROM supplier_offers o JOIN ours ON ours.sku_code = o.number_code
          AND (ours.brand_code = '' OR ours.brand_code = upper(regexp_replace(coalesce(o.brand, ''), '[^A-Za-zА-Яа-яІЇЄҐіїєґ0-9]', '', 'g')))
        WHERE o.tenant_id = $1 AND o.connection_id = $2 GROUP BY o.external_id)
     UPDATE supplier_offers o SET product_id = s.product_id FROM by_sku s
      WHERE o.connection_id = $2 AND o.external_id = s.external_id AND s.n = 1 AND o.product_id IS DISTINCT FROM s.product_id`,
    [tenantId, connectionId])
}

/** Одна порція прайсу (до PAGES_PER_RUN сторінок). Наприкінці повного проходу — зниклі товари обнуляються. */
export async function syncConnectionStep(connection: { id: string; tenant_id: string; api_key: string; sync_page: number; sync_started_at: string | null; last_full_sync_at: string | null }, deps: OmegaDeps & { now?: number } = {}) {
  const now = deps.now ?? Date.now()
  if (!connection.sync_started_at && connection.last_full_sync_at && now - Date.parse(connection.last_full_sync_at) < FULL_PASS_EVERY_MS) return { ran: false }
  const passStarted = connection.sync_started_at ? new Date(connection.sync_started_at) : new Date(now)
  let page = connection.sync_started_at ? connection.sync_page : 1
  const retail = await retailFor(connection.tenant_id)
  let done = false, fetched = 0, total = 0
  try {
    for (let step = 0; step < PAGES_PER_RUN; step++) {
      const { items, total: reported } = await omegaPage(connection.api_key, page, deps)
      total = reported
      const offers = items.map(item => omegaOffer(item, retail)).filter((offer): offer is OfferRow => Boolean(offer))
      await writeOffers(connection.tenant_id, connection.id, offers)
      fetched += items.length
      if (!items.length || page * OMEGA_PAGE_SIZE >= reported) { done = true; break }
      page += 1
    }
  } catch (error) {
    await pool.query('UPDATE supplier_api_connections SET sync_page = $2, sync_started_at = $3, last_error = $4, updated_at = now() WHERE id = $1',
      [connection.id, page, passStarted.toISOString(), (error instanceof Error ? error.message : 'Помилка завантаження').slice(0, 500)])
    throw error
  }
  if (done) {
    // Чого в цьому проході не було — того в постачальника вже немає: залишок 0 (рядок лишається для історії й сайту).
    await pool.query(`UPDATE supplier_offers SET stock = '[]'::jsonb, total_qty = 0, updated_at = now() WHERE connection_id = $1 AND seen_at < $2 AND total_qty > 0`, [connection.id, passStarted.toISOString()])
    await linkOffers(connection.tenant_id, connection.id)
    await pool.query(`UPDATE supplier_api_connections SET sync_page = 1, sync_started_at = NULL, last_full_sync_at = now(), last_error = NULL, total_offers = $2, updated_at = now() WHERE id = $1`, [connection.id, total])
  } else {
    await pool.query('UPDATE supplier_api_connections SET sync_page = $2, sync_started_at = $3, last_error = NULL, total_offers = $4, updated_at = now() WHERE id = $1', [connection.id, page + 1, passStarted.toISOString(), total])
  }
  return { ran: true, fetched, page, done, total }
}

/** Виклик планувальника: по одній порції для кожного увімкненого підключення. */
export async function runSupplierSync(deps: OmegaDeps = {}) {
  const { rows } = await pool.query('SELECT id, tenant_id, api_key, sync_page, sync_started_at, last_full_sync_at FROM supplier_api_connections WHERE enabled ORDER BY updated_at LIMIT 5')
  const results = []
  for (const row of rows) {
    try { results.push({ id: row.id, ...(await syncConnectionStep({ ...row, sync_started_at: row.sync_started_at ? new Date(row.sync_started_at).toISOString() : null,
      last_full_sync_at: row.last_full_sync_at ? new Date(row.last_full_sync_at).toISOString() : null }, deps)) }) }
    catch (error) { results.push({ id: row.id, error: error instanceof Error ? error.message : 'error' }) }
  }
  return results
}

/** «Оновити зараз»: наступний виклик планувальника почне повний прохід, не чекаючи години. */
export async function requestSyncNow(tenantId: string, id: string) {
  await pool.query('UPDATE supplier_api_connections SET last_full_sync_at = NULL WHERE tenant_id = $1 AND id = $2 AND sync_started_at IS NULL', [tenantId, id])
  return listConnections(tenantId)
}

// ── Пошук під замовлення ───────────────────────────────────────────────────────────────────────

/**
 * Пошук за артикулом (без знаків, точний або початок) — для бланка замовлення. Повертає склади з кількістю й строком,
 * роздрібну ціну; закупку — лише якщо withPurchase.
 */
export async function searchOffers(tenantId: string, query: string, withPurchase: boolean) {
  const needle = code(query)
  if (needle.length < 3) return []
  const { rows } = await pool.query(
    `SELECT o.connection_id, c.name AS supplier, c.supplier_id, o.external_id, o.number, o.brand, o.name, o.image_url, o.purchase_price, o.retail_price, o.stock, o.total_qty, o.product_id, o.updated_at
       FROM supplier_offers o JOIN supplier_api_connections c ON c.id = o.connection_id AND c.enabled
      WHERE o.tenant_id = $1 AND (o.number_code = $2 OR (length($2) >= 5 AND o.number_code LIKE $2 || '%'))
      ORDER BY (o.number_code = $2) DESC, o.total_qty > 0 DESC, o.retail_price LIMIT 30`, [tenantId, needle])
  if (!rows.length) return []
  const warehouses = (await pool.query('SELECT connection_id, code, name, city, days_to_ship, is_active FROM supplier_warehouses WHERE tenant_id = $1', [tenantId])).rows
  const byKey = new Map(warehouses.map((w: any) => [w.connection_id + '|' + w.code, w]))
  return rows.map((row: any) => {
    const stock = (Array.isArray(row.stock) ? row.stock : []).map((rest: { w: string; q: number }) => {
      const w: any = byKey.get(row.connection_id + '|' + rest.w)
      return { warehouse: rest.w, city: w?.city ?? null, qty: Number(rest.q) || 0, days_to_ship: w?.days_to_ship ?? null, active: w ? w.is_active !== false : true }
    }).filter((rest: { active: boolean }) => rest.active).sort((a: any, b: any) => (a.days_to_ship ?? 99) - (b.days_to_ship ?? 99) || b.qty - a.qty)
    return { supplier: row.supplier, supplier_id: row.supplier_id, external_id: row.external_id, number: row.number, brand: row.brand, name: row.name, image_url: row.image_url,
      retail_price: Number(row.retail_price), ...(withPurchase ? { purchase_price: Number(row.purchase_price) } : {}),
      total_qty: Number(row.total_qty), product_id: row.product_id, stock, updated_at: new Date(row.updated_at).toISOString() }
  })
}
