import { z } from 'zod'
import { pool } from '../db/pg.js'
import { applyMarkup, roundingFromSettings, type MarkupRule } from '../lib/markup.js'
import { AppError } from '../middleware/errorHandler.js'
import { guessCategory, learnCategories } from './supplierCategories.js'

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
// 25.11.2026 (власник: «нехай кроси качаються ~13 діб, у нас є час»): прайс оновлюється раз на 3 год, щоб ліміт ішов кросам.
export const FULL_PASS_EVERY_MS = 3 * 60 * 60_000
/**
 * Ліміти Омеги (з її опису API): 30 запитів на хвилину та/або 300 на годину; за перевищення обліковий запис блокують
 * автоматично. Тримаємо запас: не більше 250 на годину й 20 на хвилину — на ВСІ запити разом (прайс і фото).
 */
export const CALLS_PER_HOUR = 250
export const CALLS_PER_MINUTE = 20
/** Скільки фото питати за один виклик планувальника (12 викликів на годину → до 180 фото). */
export const PHOTOS_PER_RUN = 15
/** Скільки фото тримати в сховищі, доки власник не підніме межу: ~14 КБ на фото, 30 000 ≈ 420 МБ. */
export const PHOTO_STORAGE_CAP = 30_000
export const PHOTO_BUCKET = 'supplier-photos'

export const code = (value: unknown) => String(value ?? '').normalize('NFKC').toLocaleUpperCase('uk-UA').replace(/[^A-ZА-ЯІЇЄҐ0-9]/g, '')
const kopecks = (uah: unknown) => { const n = Number(uah); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0 }
/** «Львів 1» → «Львів»; «Київ_Правий_Південь» → «Київ». */
export const warehouseCity = (name: string) => name.split(/[\s_]+/)[0]?.replace(/\d+$/, '') || null

export interface OmegaItem { ProductId?: unknown; Card?: unknown; Number?: unknown; BrandDescription?: unknown; Description?: unknown; DescriptionUkr?: unknown
  Price?: unknown; BarCode?: unknown; ImageUrl?: unknown; Rests?: Array<{ Key?: unknown; Value?: unknown }> }
export interface OfferRow { external_id: string; number: string; number_code: string; brand: string | null; name: string; barcode: string | null; image_url: string | null
  purchase_price: number; retail_price: number; stock: Array<{ w: string; q: number }>; total_qty: number
  /** 25.11.2026: опис і категорія від постачальника (GPL дає їх у прайсі; Омега — ні). */
  description?: string | null; category_name?: string | null }

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

export async function omegaCall<T>(path: string, key: string, body: Record<string, unknown>, deps: OmegaDeps = {}, timeoutMs = 120_000): Promise<T> {
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
/** Що показати про збережений доступ: кінець ключа (Омега) або логін (GPL) — пароль ніколи. */
function accessHint(provider: string, stored: string): string {
  if (provider !== 'gpl') return hint(stored)
  try { const login = String(JSON.parse(stored)?.login ?? ''); return 'логін ' + (login.length > 4 ? login.slice(0, 3) + '…' + login.slice(-1) : '…') } catch { return '…' }
}

/**
 * 25.11.2026 (слово власника): «не видно, чи йде синхронізація зі складом — кружечок, що заповнюється зеленим,
 * і скільки лишилось у днях, годинах, хвилинах». Склади постачальника приходять одним прайсом, тож прогрес
 * складу — це прогрес проходу прайсу. Час — за фактичною швидкістю (а не за обіцянкою): прохід — від його початку,
 * черги кросів і опису — за кількістю оброблених за останню годину.
 */
export type LoadProgress = { fraction: number | null; eta_ms: number | null; loading: boolean; next_at: string | null; note?: string }
/** Розмір сторінки прайсу; для GPL — те саме, що GPL_PAGE_SIZE у supplierGpl.ts (перевіряє тест). */
export const PAGE_SIZE_BY_PROVIDER: Readonly<Record<string, number>> = { omega: OMEGA_PAGE_SIZE, gpl: 100 }

export function pricePassProgress(row: { provider: string; sync_page: number | null; sync_started_at: string | Date | null; last_full_sync_at: string | Date | null; total_offers: number | null }, now = Date.now()): LoadProgress {
  const pageSize = PAGE_SIZE_BY_PROVIDER[row.provider] ?? OMEGA_PAGE_SIZE
  const pages = row.total_offers && row.total_offers > 0 ? Math.max(1, Math.ceil(row.total_offers / pageSize)) : null
  if (!row.sync_started_at) {
    const last = row.last_full_sync_at ? new Date(row.last_full_sync_at).getTime() : null
    return { fraction: last ? 1 : 0, eta_ms: null, loading: false, next_at: last ? new Date(last + FULL_PASS_EVERY_MS).toISOString() : null }
  }
  const done = Math.max(0, Number(row.sync_page ?? 1) - 1)
  if (!pages) return { fraction: null, eta_ms: null, loading: true, next_at: null }
  const fraction = Math.min(1, done / pages)
  const elapsed = now - new Date(row.sync_started_at).getTime()
  const eta = done > 0 && elapsed > 0 ? Math.max(0, Math.round(elapsed / done * (pages - done))) : null
  return { fraction, eta_ms: eta, loading: true, next_at: null }
}

export function queueProgress(done: number, total: number, perLastHour: number): LoadProgress {
  if (!total) return { fraction: null, eta_ms: null, loading: false, next_at: null }
  const left = Math.max(0, total - done)
  const fraction = Math.min(1, done / total)
  return { fraction, eta_ms: left === 0 ? 0 : perLastHour > 0 ? Math.round(left / perLastHour * 3_600_000) : null, loading: left > 0, next_at: null }
}

/**
 * 26.11.2026 (фото власника: «написано “завантажено”, хоча кроси ще вантажаться, фото теж»): у заголовку постачальника —
 * загальний стан УСІХ завантажень. Частка — середня по частинах, що мають частку; «вантажиться», якщо хоч щось
 * вантажиться; час — найдовший із відомих.
 */
export function overallProgress(parts: ReadonlyArray<LoadProgress | undefined>): LoadProgress {
  const known = parts.filter((part): part is LoadProgress => Boolean(part))
  const withFraction = known.filter(part => part.fraction != null)
  const loading = known.filter(part => part.loading)
  const etas = loading.map(part => part.eta_ms).filter((eta): eta is number => eta != null)
  return {
    fraction: withFraction.length ? withFraction.reduce((sum, part) => sum + (part.fraction as number), 0) / withFraction.length : null,
    eta_ms: etas.length ? Math.max(...etas) : null,
    loading: loading.length > 0,
    next_at: loading.length ? null : known.map(part => part.next_at).filter(Boolean).sort()[0] ?? null,
  }
}

/** Фото Омеги — для товарів у наявності; поки кроси не докачані, фото на паузі (ліміт запитів іде кросам). */
export function photoProgress(row: { photos_enabled?: boolean; photos_total?: number; photos_done?: number; photos_hour?: number }, crosses: LoadProgress): LoadProgress {
  const base = queueProgress(row.photos_done ?? 0, row.photos_total ?? 0, row.photos_hour ?? 0)
  if (!row.photos_enabled) return { ...base, loading: false, eta_ms: null, note: 'вимкнено' }
  if (base.loading && crosses.loading) return { ...base, eta_ms: null, note: 'на паузі, поки вантажаться кроси' }
  return base
}

/** Хід усіх завантажень постачальника: прайс і склади; для Омеги ще кроси, опис і фото (у GPL фото й опис — у прайсі). */
export function connectionProgress(row: any): { overall: LoadProgress; price: LoadProgress; crosses?: LoadProgress; details?: LoadProgress; photos?: LoadProgress } {
  const price = pricePassProgress(row)
  if (row.provider !== 'omega') return { overall: price, price }
  const crosses = queueProgress(row.crosses_done ?? 0, row.offers ?? 0, row.crosses_hour ?? 0)
  const details = queueProgress(row.details_done ?? 0, row.offers ?? 0, row.details_hour ?? 0)
  const photos = photoProgress(row, crosses)
  return { overall: overallProgress([price, crosses, details, row.photos_enabled ? photos : undefined]), price, crosses, details, photos }
}

export async function listConnections(tenantId: string) {
  const { rows } = await pool.query(
    `SELECT c.id, c.provider, c.name, c.api_key, c.meta, c.enabled, c.supplier_id, c.sync_page, c.sync_started_at, c.last_full_sync_at, c.last_error, c.total_offers, c.updated_at,
            (SELECT count(*) FROM supplier_offers o WHERE o.connection_id = c.id)::int AS offers,
            (SELECT count(*) FROM supplier_offers o WHERE o.connection_id = c.id AND o.product_id IS NOT NULL)::int AS linked,
            (SELECT count(*) FROM supplier_offers o WHERE o.connection_id = c.id AND o.crosses_checked_at IS NOT NULL)::int AS crosses_done,
            (SELECT count(*) FROM supplier_offer_crosses x WHERE x.connection_id = c.id)::int AS crosses_total,
            (SELECT count(*) FROM supplier_offers o WHERE o.connection_id = c.id AND o.details_checked_at IS NOT NULL)::int AS details_done,
            (SELECT count(*) FROM supplier_offers o WHERE o.connection_id = c.id AND o.crosses_checked_at > now() - interval '1 hour')::int AS crosses_hour,
            (SELECT count(*) FROM supplier_offers o WHERE o.connection_id = c.id AND o.details_checked_at > now() - interval '1 hour')::int AS details_hour,
            c.photos_enabled,
            (SELECT count(*) FROM supplier_offers o WHERE o.connection_id = c.id AND o.total_qty > 0)::int AS photos_total,
            (SELECT count(*) FROM supplier_offers o WHERE o.connection_id = c.id AND o.total_qty > 0 AND (o.image_url IS NOT NULL OR o.photo_checked_at IS NOT NULL))::int AS photos_done,
            (SELECT count(*) FROM supplier_offers o WHERE o.connection_id = c.id AND o.photo_checked_at > now() - interval '1 hour')::int AS photos_hour
       FROM supplier_api_connections c WHERE c.tenant_id = $1 ORDER BY c.created_at`, [tenantId])
  const warehouses = (await pool.query('SELECT id, connection_id, code, name, city, days_to_ship, is_active FROM supplier_warehouses WHERE tenant_id = $1 ORDER BY name', [tenantId])).rows
  return rows.map((row: any) => ({
    id: row.id, provider: row.provider, name: row.name, key_hint: accessHint(String(row.provider), String(row.api_key)), enabled: row.enabled, supplier_id: row.supplier_id,
    meta: row.meta && typeof row.meta === 'object' ? row.meta : {},
    syncing: Boolean(row.sync_started_at), sync_page: row.sync_page, last_full_sync_at: row.last_full_sync_at ? new Date(row.last_full_sync_at).toISOString() : null,
    last_error: row.last_error, total_offers: row.total_offers, offers: row.offers, linked: row.linked,
    crosses_done: row.crosses_done ?? 0, crosses_total: row.crosses_total ?? 0, details_done: row.details_done ?? 0,
    progress: connectionProgress(row),
    warehouses: warehouses.filter((w: any) => w.connection_id === row.id).map((w: any) => ({ id: w.id, code: w.code, name: w.name, city: w.city, days_to_ship: w.days_to_ship, is_active: w.is_active })),
  }))
}

export const connectionSchema = z.union([
  z.object({
    provider: z.literal('omega'),
    name: z.string().trim().min(1).max(80).default('Омега'),
    api_key: z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9_-]+$/).optional(),
    enabled: z.boolean().default(true),
    supplier_id: z.string().uuid().nullable().optional(),
  }).strict(),
  // 25.11.2026: GPL входить логіном і паролем; зберігаються лише на сервері, назад не віддаються.
  z.object({
    provider: z.literal('gpl'),
    name: z.string().trim().min(1).max(80).default('GPL'),
    login: z.string().trim().min(2).max(120).optional(),
    password: z.string().min(4).max(200).optional(),
    enabled: z.boolean().default(true),
    supplier_id: z.string().uuid().nullable().optional(),
  }).strict(),
])

/** Зберегти підключення. Ключ перевіряємо в Омеги ДО запису — хибний ключ не затре робочий. */
export async function saveConnection(tenantId: string, userId: string, rawInput: z.infer<typeof connectionSchema>, deps: OmegaDeps = {}) {
  let input: { provider: 'omega' | 'gpl'; name: string; enabled: boolean; supplier_id?: string | null; api_key?: string }
  if (rawInput.provider === 'gpl') {
    if (Boolean(rawInput.login) !== Boolean(rawInput.password)) throw new AppError('VALIDATION_ERROR', 'Вкажіть і логін, і пароль GPL', 422)
    let stored: string | undefined
    if (rawInput.login && rawInput.password) {
      // Логін і пароль перевіряємо в GPL ДО запису — хибні не затруть робочі.
      const { gplLogin } = await import('./supplierGpl.js')
      await gplLogin({ login: rawInput.login, password: rawInput.password }, deps)
      stored = JSON.stringify({ login: rawInput.login, password: rawInput.password })
    }
    input = { provider: 'gpl', name: rawInput.name, enabled: rawInput.enabled, supplier_id: rawInput.supplier_id, api_key: stored }
  } else {
    if (rawInput.api_key) {
      const account = await omegaAccount(rawInput.api_key, deps)
      if (!account.access) throw new AppError('SUPPLIER_REFUSED', 'Омега не прийняла ключ', 422)
    }
    input = rawInput
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

/**
 * Ціна продажу — для КОЖНОГО товару КОЖНОГО постачальника (слово власника 24.11.2026: «для всіх товарів від постачальників,
 * які не в нас лежать, бо підключатиму багато різних постачальників по API»). Рахується тут, у спільному місці запису,
 * а не в розборі прайсу окремого постачальника: новий постачальник не може записати товар без ціни продажу чи з ціною
 * нижче закупки, хоч би що повернув його розбір. Товар без закупівельної ціни не записується взагалі.
 */
export function pricedOffers(offers: readonly OfferRow[], retail: (purchase: number) => number): OfferRow[] {
  return offers.filter(offer => Number.isFinite(offer.purchase_price) && offer.purchase_price > 0)
    .map(offer => ({ ...offer, retail_price: Math.max(offer.purchase_price, Math.round(retail(offer.purchase_price)) || 0) }))
}

async function writeOffers(tenantId: string, connectionId: string, rawOffers: OfferRow[], retail: (purchase: number) => number) {
  const offers = pricedOffers(rawOffers, retail)
  if (!offers.length) return
  await pool.query(
    `INSERT INTO supplier_offers (tenant_id, connection_id, external_id, number, number_code, brand, name, barcode, image_url, purchase_price, retail_price, stock, total_qty, description, category_name, seen_at, updated_at)
     SELECT $1, $2, x.external_id, x.number, x.number_code, x.brand, x.name, x.barcode, x.image_url, x.purchase_price, x.retail_price, x.stock, x.total_qty, x.description, x.category_name, now(), now()
       FROM jsonb_to_recordset($3::jsonb) AS x(external_id text, number text, number_code text, brand text, name text, barcode text, image_url text,
            purchase_price bigint, retail_price bigint, stock jsonb, total_qty int, description text, category_name text)
     ON CONFLICT (connection_id, external_id) DO UPDATE SET
       number = EXCLUDED.number, number_code = EXCLUDED.number_code, brand = EXCLUDED.brand, name = EXCLUDED.name, barcode = EXCLUDED.barcode,
       image_url = COALESCE(EXCLUDED.image_url, supplier_offers.image_url), purchase_price = EXCLUDED.purchase_price, retail_price = EXCLUDED.retail_price,
       stock = EXCLUDED.stock, total_qty = EXCLUDED.total_qty, seen_at = now(),
       description = COALESCE(EXCLUDED.description, supplier_offers.description), category_name = COALESCE(EXCLUDED.category_name, supplier_offers.category_name),
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
 * Чи той самий це товар: наша картка і товар постачальника. Лише однозначний збіг І той самий бренд:
 *  - артикул картки = номер постачальника, або номер (від 6 знаків) стоїть окремим словом у назві картки;
 *  - бренд постачальника — бренд картки або є в її назві. Без бренду не привʼязуємо: на пробі «28.0110» Adriauto
 *    лягав у подовжувач HANS «2801-10».
 */
export function matchOffers(ours: Array<{ id: string; sku: string; name: string; brand: string | null }>, offers: Array<{ external_id: string; number_code: string; brand: string | null }>): Map<string, string> {
  const bySku = new Map<string, string[]>(), byToken = new Map<string, string[]>()
  const cards = new Map<string, { brand: string; name: string }>()
  const add = (map: Map<string, string[]>, key: string, id: string) => { if (!key) return; const ids = map.get(key); if (ids) { if (!ids.includes(id)) ids.push(id) } else map.set(key, [id]) }
  for (const card of ours) {
    cards.set(card.id, { brand: code(card.brand), name: code(card.name) })
    add(bySku, code(card.sku), card.id)
    for (const token of String(card.name).split(/\s+/)) { const key = code(token); if (key.length >= 6 && /\d/.test(key)) add(byToken, key, card.id) }
  }
  const links = new Map<string, string>()
  for (const offer of offers) {
    const brand = code(offer.brand)
    if (brand.length < 2 || !offer.number_code) continue
    const found = new Set<string>([...(bySku.get(offer.number_code) ?? []), ...(offer.number_code.length >= 6 ? byToken.get(offer.number_code) ?? [] : [])])
    const fitting = [...found].filter(id => { const card = cards.get(id)!; return card.brand === brand || card.name.includes(brand) })
    if (fitting.length === 1) links.set(offer.external_id, fitting[0])
  }
  return links
}

/**
 * Привʼязати товари постачальника до наших карток (у памʼяті сервера: 17 тис. карток × 80 тис. товарів запитом до бази
 * не вкладались у час — 24.11.2026 перший прохід через це не завершувався). Карткою складу товар не стає.
 */
export async function linkOffers(tenantId: string, connectionId: string) {
  const ours = (await pool.query(`SELECT p.id, p.sku, p.name, b.name AS brand FROM products p LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
     WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.is_active`, [tenantId])).rows
  const offers = (await pool.query('SELECT external_id, number_code, brand, product_id FROM supplier_offers WHERE connection_id = $1', [connectionId])).rows
  const links = matchOffers(ours, offers)
  const changes = offers.filter((offer: any) => (links.get(offer.external_id) ?? null) !== (offer.product_id ?? null))
    .map((offer: any) => ({ external_id: offer.external_id as string, product_id: links.get(offer.external_id) ?? null }))
  for (let from = 0; from < changes.length; from += 5000) {
    await pool.query(`UPDATE supplier_offers o SET product_id = x.product_id FROM jsonb_to_recordset($2::jsonb) AS x(external_id text, product_id uuid)
       WHERE o.connection_id = $1 AND o.external_id = x.external_id`, [connectionId, JSON.stringify(changes.slice(from, from + 5000))])
  }
  return { linked: links.size, changed: changes.length }
}

/**
 * Розкласти товари постачальника по наших категоріях (рішення власника 24.11.2026). Модель вчиться на наших картках;
 * невпевнене — без категорії. Категорію, поставлену людиною (category_source = 'manual'), не чіпаємо ніколи.
 */
export async function categorizeOffers(tenantId: string, connectionId: string) {
  const products = (await pool.query('SELECT name, category_id FROM products WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active AND category_id IS NOT NULL', [tenantId])).rows
  const model = learnCategories(products)
  const offers = (await pool.query(`SELECT external_id, name, category_id FROM supplier_offers WHERE connection_id = $1 AND category_source IS DISTINCT FROM 'manual'`, [connectionId])).rows
  const changes = offers.map((offer: any) => ({ external_id: offer.external_id as string, category_id: guessCategory(model, offer.name), before: offer.category_id as string | null }))
    .filter(change => change.category_id !== change.before)
  for (let start = 0; start < changes.length; start += 5000) {
    await pool.query(
      `UPDATE supplier_offers o SET category_id = x.category_id, category_source = CASE WHEN x.category_id IS NULL THEN NULL ELSE 'auto' END, updated_at = now()
         FROM jsonb_to_recordset($2::jsonb) AS x(external_id text, category_id uuid)
        WHERE o.connection_id = $1 AND o.external_id = x.external_id AND o.category_source IS DISTINCT FROM 'manual'`,
      [connectionId, JSON.stringify(changes.slice(start, start + 5000).map(({ external_id, category_id }) => ({ external_id, category_id })))])
  }
  return { changed: changes.length, categorized: offers.length - changes.filter(change => !change.category_id).length }
}

/**
 * Дозвіл на один запит до постачальника. Лічильник — у базі, один на всі виклики сервера: два одночасні виклики
 * планувальника не перевищать ліміт удвох. false — на цю хвилину чи годину досить.
 */
export async function takeCall(connectionId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `UPDATE supplier_api_connections SET
        calls_hour_start = CASE WHEN calls_hour_start IS NULL OR calls_hour_start < now() - interval '1 hour' THEN now() ELSE calls_hour_start END,
        calls_hour_count = CASE WHEN calls_hour_start IS NULL OR calls_hour_start < now() - interval '1 hour' THEN 1 ELSE calls_hour_count + 1 END,
        calls_minute_start = CASE WHEN calls_minute_start IS NULL OR calls_minute_start < now() - interval '1 minute' THEN now() ELSE calls_minute_start END,
        calls_minute_count = CASE WHEN calls_minute_start IS NULL OR calls_minute_start < now() - interval '1 minute' THEN 1 ELSE calls_minute_count + 1 END
      WHERE id = $1
        AND (calls_hour_start IS NULL OR calls_hour_start < now() - interval '1 hour' OR calls_hour_count < $2)
        AND (calls_minute_start IS NULL OR calls_minute_start < now() - interval '1 minute' OR calls_minute_count < $3)
      RETURNING id`, [connectionId, CALLS_PER_HOUR, CALLS_PER_MINUTE])
  return rows.length > 0
}

/** Фото товару з Омеги: байти JPEG/PNG або null (фото немає). Один запит. */
export async function omegaImage(key: string, productId: string, deps: OmegaDeps = {}): Promise<{ bytes: Buffer; type: string } | null> {
  if (!/^-?\d{1,18}$/.test(productId)) return null
  let response: Response
  try {
    response = await (deps.fetchImpl ?? fetch)(OMEGA_BASE + '/product/image', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ProductId: Number(productId), Number: 1, Key: key }), redirect: 'error', signal: AbortSignal.timeout(30_000) })
  } catch { throw new AppError('SUPPLIER_UNREACHABLE', 'Омега не відповіла на запит фото', 502) }
  if (response.status === 429 || response.status === 403) throw new AppError('SUPPLIER_LIMIT', 'Омега обмежила запити', 502)
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!response.ok || !['image/jpeg', 'image/png'].includes(type)) return null
  const bytes = Buffer.from(await response.arrayBuffer())
  // Справжнє зображення за першими байтами й розумного розміру; інше — «фото немає».
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8, png = bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47
  if ((!jpeg && !png) || bytes.length < 500 || bytes.length > 1_000_000) return null
  return { bytes, type: jpeg ? 'image/jpeg' : 'image/png' }
}

export interface PhotoDeps extends OmegaDeps { upload?: (path: string, bytes: Buffer, type: string) => Promise<string> }

async function uploadPhoto(path: string, bytes: Buffer, type: string): Promise<string> {
  const { supabaseAdmin } = await import('../db/supabaseAdmin.js')
  const saved = await supabaseAdmin.storage.from(PHOTO_BUCKET).upload(path, bytes, { contentType: type, upsert: true, cacheControl: '31536000' })
  if (saved.error) throw new Error('Сховище не прийняло фото: ' + saved.error.message)
  return supabaseAdmin.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl
}

/**
 * Порція фото: спершу товари, що збіглися з нашими картками, далі — з категорією, далі решта; у кожній групі — де більший
 * залишок. Товар без фото в Омеги позначаємо й не питаємо знову 30 днів. Зупиняється, щойно лічильник запитів каже «досить».
 */
export async function syncPhotosStep(connection: { id: string; tenant_id: string; api_key: string }, deps: PhotoDeps = {}, max = PHOTOS_PER_RUN) {
  const stored = Number((await pool.query('SELECT count(*)::int AS n FROM supplier_offers WHERE connection_id = $1 AND photo_saved_at IS NOT NULL', [connection.id])).rows[0]?.n) || 0
  if (stored >= PHOTO_STORAGE_CAP) return { saved: 0, none: 0, stopped: 'cap' as const }
  const { rows } = await pool.query(
    `SELECT external_id FROM supplier_offers
      WHERE connection_id = $1 AND image_url IS NULL AND total_qty > 0 AND (photo_checked_at IS NULL OR photo_checked_at < now() - interval '30 days')
      ORDER BY (product_id IS NOT NULL) DESC, (category_id IS NOT NULL) DESC, total_qty DESC, external_id LIMIT $2`, [connection.id, Math.min(max, PHOTO_STORAGE_CAP - stored)])
  let saved = 0, none = 0
  for (const row of rows) {
    if (!await takeCall(connection.id)) return { saved, none, stopped: 'limit' as const }
    const image = await omegaImage(connection.api_key, String(row.external_id), deps)
    if (!image) { none += 1; await pool.query('UPDATE supplier_offers SET photo_checked_at = now() WHERE connection_id = $1 AND external_id = $2', [connection.id, row.external_id]); continue }
    const path = connection.tenant_id + '/' + connection.id + '/' + String(row.external_id).replace(/[^0-9A-Za-z_-]/g, '_') + (image.type === 'image/png' ? '.png' : '.jpg')
    const url = await (deps.upload ?? uploadPhoto)(path, image.bytes, image.type)
    await pool.query('UPDATE supplier_offers SET image_url = $3, photo_checked_at = now(), photo_saved_at = now(), updated_at = now() WHERE connection_id = $1 AND external_id = $2', [connection.id, row.external_id, url])
    saved += 1
  }
  return { saved, none, stopped: null }
}

/** Фото для НАШИХ карток, що збіглися з товарами постачальника: головний ПК ставить їх у картки без фото. */
export async function linkedOfferPhotos(tenantId: string, since: string | null) {
  const { rows } = await pool.query(
    `SELECT product_id, image_url, photo_saved_at FROM supplier_offers
      WHERE tenant_id = $1 AND product_id IS NOT NULL AND image_url IS NOT NULL AND photo_saved_at IS NOT NULL AND ($2::timestamptz IS NULL OR photo_saved_at > $2::timestamptz)
      ORDER BY photo_saved_at LIMIT 200`, [tenantId, since])
  return rows.map((row: any) => ({ program_product_id: row.product_id as string, full: String(row.image_url), found_at: new Date(row.photo_saved_at).toISOString() }))
}

/** Одна порція прайсу (до PAGES_PER_RUN сторінок). Наприкінці повного проходу — зниклі товари обнуляються. */
export async function syncConnectionStep(connection: { id: string; tenant_id: string; api_key: string; provider?: string; sync_page: number; sync_started_at: string | null; last_full_sync_at: string | null }, deps: OmegaDeps & { now?: number } = {}) {
  const now = deps.now ?? Date.now()
  if (!connection.sync_started_at && connection.last_full_sync_at && now - Date.parse(connection.last_full_sync_at) < FULL_PASS_EVERY_MS) return { ran: false }
  // 25.11.2026: GPL — свій прайс (логін → сторінки), той самий запис, привʼязка й завершення проходу.
  const gpl = connection.provider === 'gpl' ? await import('./supplierGpl.js') : null
  let gplToken: string | null = null
  const priceNames = new Set<string>()
  let purchaseName: string | null = null
  const passStarted = connection.sync_started_at ? new Date(connection.sync_started_at) : new Date(now)
  let page = connection.sync_started_at ? connection.sync_page : 1
  const retail = await retailFor(connection.tenant_id)
  let done = false, fetched = 0, total = 0
  try {
    for (let step = 0; step < PAGES_PER_RUN; step++) {
      // Ліміт запитів Омеги спільний для прайсу й фото: не дали дозволу — продовжимо з цієї ж сторінки наступного разу.
      if (!await takeCall(connection.id)) break
      if (gpl) {
        if (!gplToken) {
          gplToken = await gpl.gplLogin(gpl.gplCredentials(connection.api_key), deps)
          if (!await takeCall(connection.id)) break
        }
        const answer = await gpl.gplPage(gplToken, page, deps)
        total = answer.total
        for (const item of answer.items) for (const price of item.prices ?? []) if (price?.name) priceNames.add(String(price.name).slice(0, 80))
        purchaseName = answer.items.map(item => gpl.gplPurchase(item.prices).name).find(Boolean) ?? purchaseName
        const offers = answer.items.map(item => gpl.gplOffer(item)).filter((offer): offer is NonNullable<typeof offer> => Boolean(offer))
        await writeOffers(connection.tenant_id, connection.id, offers, retail)
        fetched += answer.items.length
        if (!answer.items.length || page >= answer.lastPage) { done = true; break }
        page += 1
        continue
      }
      const { items, total: reported } = await omegaPage(connection.api_key, page, deps)
      total = reported
      const offers = items.map(item => omegaOffer(item, retail)).filter((offer): offer is OfferRow => Boolean(offer))
      await writeOffers(connection.tenant_id, connection.id, offers, retail)
      fetched += items.length
      if (!items.length || page * OMEGA_PAGE_SIZE >= reported) { done = true; break }
      page += 1
    }
  } catch (error) {
    await pool.query('UPDATE supplier_api_connections SET sync_page = $2, sync_started_at = $3, last_error = $4, updated_at = now() WHERE id = $1',
      [connection.id, page, passStarted.toISOString(), (error instanceof Error ? error.message : 'Помилка завантаження').slice(0, 500)])
    throw error
  }
  if (priceNames.size) await pool.query(`UPDATE supplier_api_connections SET meta = meta || jsonb_build_object('price_names', $2::jsonb, 'purchase_price_name', $3::text) WHERE id = $1`,
    [connection.id, JSON.stringify([...priceNames].slice(0, 20)), purchaseName])
  if (done) {
    // Чого в цьому проході не було — того в постачальника вже немає: залишок 0 (рядок лишається для історії й сайту).
    await pool.query(`UPDATE supplier_offers SET stock = '[]'::jsonb, total_qty = 0, updated_at = now() WHERE connection_id = $1 AND seen_at < $2 AND total_qty > 0`, [connection.id, passStarted.toISOString()])
    // Привʼязка й категорії — доповнення: їх збій не має лишати прохід прайсу незавершеним (причина — в last_error).
    let afterError: string | null = null
    try { await linkOffers(connection.tenant_id, connection.id) } catch (error) { afterError = 'Привʼязка до карток: ' + (error instanceof Error ? error.message : 'помилка') }
    try { await categorizeOffers(connection.tenant_id, connection.id) } catch (error) { afterError = (afterError ? afterError + '; ' : '') + 'Категорії: ' + (error instanceof Error ? error.message : 'помилка') }
    await pool.query(`UPDATE supplier_api_connections SET sync_page = 1, sync_started_at = NULL, last_full_sync_at = now(), last_error = $3, total_offers = COALESCE($2, total_offers), updated_at = now() WHERE id = $1`, [connection.id, total || null, afterError ? afterError.slice(0, 500) : null])
  } else {
    await pool.query('UPDATE supplier_api_connections SET sync_page = $2, sync_started_at = $3, last_error = NULL, total_offers = COALESCE($4, total_offers), updated_at = now() WHERE id = $1', [connection.id, page, passStarted.toISOString(), total || null])
  }
  return { ran: true, fetched, page, done, total }
}

/** Виклик планувальника: по одній порції для кожного увімкненого підключення. */
export async function runSupplierSync(deps: OmegaDeps = {}) {
  const { rows } = await pool.query('SELECT id, tenant_id, provider, api_key, sync_page, sync_started_at, last_full_sync_at, photos_enabled FROM supplier_api_connections WHERE enabled ORDER BY updated_at LIMIT 5')
  const results = []
  for (const row of rows) {
    try { results.push({ id: row.id, ...(await syncConnectionStep({ ...row, sync_started_at: row.sync_started_at ? new Date(row.sync_started_at).toISOString() : null,
      last_full_sync_at: row.last_full_sync_at ? new Date(row.last_full_sync_at).toISOString() : null }, deps)) }) }
    catch (error) { results.push({ id: row.id, error: error instanceof Error ? error.message : 'error' }) }
    // Кроси, опис і фото — методи API Омеги; у GPL їх немає (аналоги для GPL беруться з кросів Омеги за артикулом).
    if (row.provider !== 'omega') continue
    // 25.11.2026: кроси для наших карток — після прайсу, перед фото (кілька запитів за прохід, той самий лічильник).
    try {
      const { syncCrossesStep } = await import('./supplierCrosses.js')
      results.push({ id: row.id, crosses: await syncCrossesStep(row, deps) })
    } catch (error) { results.push({ id: row.id, crosses_error: error instanceof Error ? error.message : 'error' }) }
    // 25.11.2026: опис (OE-номери, застосовність, характеристики) — пачкою, один запит за прохід.
    try {
      const { syncDetailsStep } = await import('./supplierDetails.js')
      results.push({ id: row.id, details: await syncDetailsStep(row, deps) })
    } catch (error) { results.push({ id: row.id, details_error: error instanceof Error ? error.message : 'error' }) }
    // Фото — після прайсу й лише в межах того самого лічильника запитів.
    // 25.11.2026: поки кроси не докачано, фото на паузі — весь ліміт іде кросам (рішення власника).
    const crossesLeft = await pool.query('SELECT 1 FROM supplier_offers WHERE connection_id = $1 AND crosses_checked_at IS NULL LIMIT 1', [row.id])
      .then(result => result.rows.length > 0, () => false)
    if (row.photos_enabled && !crossesLeft) {
      try { results.push({ id: row.id, photos: await syncPhotosStep(row, deps) }) }
      catch (error) { results.push({ id: row.id, photos_error: error instanceof Error ? error.message : 'error' }) }
    }
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
    `SELECT o.connection_id, c.name AS supplier, c.supplier_id, o.external_id, o.number, o.brand, COALESCE(o.custom_name, o.name) AS name, o.image_url, o.purchase_price, COALESCE(o.custom_price, o.retail_price) AS retail_price, o.stock, o.total_qty, o.product_id, o.updated_at, o.description, o.category_name
       FROM supplier_offers o JOIN supplier_api_connections c ON c.id = o.connection_id AND c.enabled
      WHERE o.tenant_id = $1 AND NOT o.hidden AND (o.number_code = $2 OR (length($2) >= 5 AND o.number_code LIKE $2 || '%'))
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
      total_qty: Number(row.total_qty), product_id: row.product_id, stock, updated_at: new Date(row.updated_at).toISOString(),
      description: row.description ?? null, category_name: row.category_name ?? null }
  })
}
