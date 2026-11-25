import { pool, runTransaction } from '../db/pg.js'
import { code, omegaCall, takeCall, type OmegaDeps } from './supplierApiService.js'

/**
 * Крос-номери (аналоги) товарів постачальника. Слово власника 25.11.2026: «хочу використовувати крос-номери Омеги
 * в програмі для підбору аналогів — там велика база, і на сайті теж».
 * Омега віддає кроси одним запитом на товар (/product/getAllCrosses, Gold), тому: заздалегідь — лише для товарів,
 * що збіглися з НАШИМИ картками; решту — на вимогу, коли шукають артикул. Усе — через спільний лічильник takeCall
 * (Омега блокує обліковий запис за >30 запитів/хв чи >300/год). Ключ постачальника не виходить за межі сервера.
 */

/**
 * Скільки товарів за один прохід планувальника (раз на 5 хв) отримують кроси: до 18 (ліміт 20/хв) → ~200 запитів/год із 250.
 * Слово власника 25.11.2026: «щоб скачались усі кроси, що є в Омеги, — по мірі можливості, не порушуючи лімітів».
 * Черга: наші картки → товари в наявності (ходові першими) → решта. Прайс (раз на 3 год) і опис — раніше; фото — на паузі, поки кроси не докачано.
 */
export const CROSSES_PER_RUN = 18 // упирається в ліміт 20/хв і 250/год лічильника takeCall

export interface OfferCross { code: string; code_key: string; brand: string; replacement_type: string | null }

/** Відповідь Омеги → чисті рядки: без порожніх кодів і повторів, не більше 300. */
export function crossRows(data: unknown): OfferCross[] {
  const list = Array.isArray(data) ? data : []
  const seen = new Set<string>()
  const rows: OfferCross[] = []
  for (const raw of list) {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const text = String(item.Code ?? '').trim().slice(0, 120)
    const key = code(text).slice(0, 120)
    if (!key) continue
    const brand = String(item.Brand ?? '').trim().slice(0, 120)
    const id = key + '|' + brand.toLocaleUpperCase('uk-UA')
    if (seen.has(id)) continue
    seen.add(id)
    rows.push({ code: text, code_key: key, brand, replacement_type: String(item.ReplacementType ?? '').trim().slice(0, 120) || null })
    if (rows.length >= 300) break
  }
  return rows
}

/** Кроси одного товару Омеги (один запит). ProductId — ціле число Омеги з нашого external_id. */
export async function omegaCrosses(key: string, productId: string, deps: OmegaDeps = {}): Promise<OfferCross[]> {
  if (!/^-?\d{1,15}$/.test(productId)) return [] // номери Омеги бувають відʼємні (-87748)
  const answer = await omegaCall<{ Data?: unknown }>('/product/getAllCrosses', key, { ProductId: Number(productId) }, deps, 30_000)
  return crossRows(answer.Data)
}

type Connection = { id: string; tenant_id: string; api_key: string }

/** Запитати й зберегти кроси товару. false — ліміт запитів на цю хвилину/годину вичерпано (спробуємо пізніше). */
export async function fetchOfferCrosses(connection: Connection, externalId: string, deps: OmegaDeps = {}): Promise<boolean> {
  if (!await takeCall(connection.id)) return false
  const crosses = await omegaCrosses(connection.api_key, externalId, deps)
  await runTransaction(async client => {
    await client.query('DELETE FROM supplier_offer_crosses WHERE connection_id = $1 AND external_id = $2', [connection.id, externalId])
    for (const cross of crosses) {
      await client.query(
        `INSERT INTO supplier_offer_crosses (tenant_id, connection_id, external_id, code, code_key, brand, replacement_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [connection.tenant_id, connection.id, externalId, cross.code, cross.code_key, cross.brand, cross.replacement_type])
    }
    await client.query('UPDATE supplier_offers SET crosses_checked_at = now() WHERE connection_id = $1 AND external_id = $2', [connection.id, externalId])
  })
  return true
}

/** Фоном — кроси ВСІХ товарів постачальника, порціями: спершу наші картки, далі ті, що є в наявності. */
export async function syncCrossesStep(connection: Connection, deps: OmegaDeps = {}, max = CROSSES_PER_RUN) {
  const { rows } = await pool.query(
    `SELECT external_id FROM supplier_offers WHERE connection_id = $1 AND crosses_checked_at IS NULL
     ORDER BY (product_id IS NOT NULL) DESC, total_qty DESC, external_id LIMIT $2`, [connection.id, max])
  let fetched = 0
  for (const row of rows) {
    if (!await fetchOfferCrosses(connection, String(row.external_id), deps)) return { fetched, stopped: 'limit' as const }
    fetched += 1
  }
  return { fetched, stopped: null }
}

const upper = (value: unknown) => String(value ?? '').toLocaleUpperCase('uk-UA')

/**
 * Аналоги за артикулом: товари постачальника з цим артикулом → їхні кроси (якщо ще не питали — питаємо зараз, у межах
 * ліміту), плюс товари постачальника, у яких цей артикул записано як крос. Для кожного кросу — наші картки з тим самим
 * артикулом і товари постачальника в наявності. Закупка — лише withPurchase.
 */
export async function searchCrosses(tenantId: string, query: string, withPurchase: boolean, deps: OmegaDeps = {}) {
  const needle = code(query)
  if (needle.length < 3) return { query: needle, crosses: [], pending: false }
  const offers = (await pool.query(
    `SELECT o.connection_id, o.external_id, o.crosses_checked_at, c.tenant_id, c.api_key
       FROM supplier_offers o JOIN supplier_api_connections c ON c.id = o.connection_id AND c.enabled
      WHERE o.tenant_id = $1 AND o.number_code = $2 ORDER BY o.total_qty DESC LIMIT 3`, [tenantId, needle])).rows
  let pending = false
  for (const offer of offers) {
    if (offer.crosses_checked_at) continue
    try {
      const done = await fetchOfferCrosses({ id: offer.connection_id, tenant_id: offer.tenant_id, api_key: offer.api_key }, String(offer.external_id), deps)
      if (!done) pending = true
    } catch { pending = true }
  }
  const { rows: crossList } = await pool.query(
    `SELECT DISTINCT x.code, x.code_key, x.brand, x.replacement_type
       FROM supplier_offer_crosses x JOIN supplier_offers o ON o.connection_id = x.connection_id AND o.external_id = x.external_id
      WHERE x.tenant_id = $1 AND o.number_code = $2
     UNION
     SELECT DISTINCT o.number AS code, o.number_code AS code_key, COALESCE(o.brand, '') AS brand, NULL AS replacement_type
       FROM supplier_offer_crosses x JOIN supplier_offers o ON o.connection_id = x.connection_id AND o.external_id = x.external_id
      WHERE x.tenant_id = $1 AND x.code_key = $2 AND o.number_code <> $2
     UNION
     SELECT DISTINCT e.code, e.code_key, '' AS brand, 'OE' AS replacement_type
       FROM supplier_offer_oe e JOIN supplier_offers o ON o.connection_id = e.connection_id AND o.external_id = e.external_id
      WHERE e.tenant_id = $1 AND o.number_code = $2
     UNION
     SELECT DISTINCT o.number AS code, o.number_code AS code_key, COALESCE(o.brand, '') AS brand, 'за OE-номером' AS replacement_type
       FROM supplier_offer_oe e JOIN supplier_offers o ON o.connection_id = e.connection_id AND o.external_id = e.external_id
      WHERE e.tenant_id = $1 AND e.code_key = $2 AND o.number_code <> $2
     LIMIT 300`, [tenantId, needle])
  const rows = crossList.filter((row: any) => String(row.code_key) !== needle)
  const keys = [...new Set(rows.map((row: any) => String(row.code_key)))]
  if (!keys.length) return { query: needle, crosses: [], pending }
  const ours = (await pool.query(
    `SELECT id, name, sku, qty_on_hand, retail_price, regexp_replace(upper(COALESCE(sku, '')), '[^A-ZА-ЯІЇЄҐ0-9]', '', 'g') AS sku_key
       FROM products WHERE tenant_id = $1 AND deleted_at IS NULL
        AND regexp_replace(upper(COALESCE(sku, '')), '[^A-ZА-ЯІЇЄҐ0-9]', '', 'g') = ANY($2::text[])`, [tenantId, keys])).rows
  const supplier = (await pool.query(
    `SELECT o.number_code, o.external_id, o.number, o.brand, o.name, o.image_url, o.retail_price, o.purchase_price, o.total_qty
       FROM supplier_offers o JOIN supplier_api_connections c ON c.id = o.connection_id AND c.enabled
      WHERE o.tenant_id = $1 AND o.number_code = ANY($2::text[]) AND o.total_qty > 0 ORDER BY o.retail_price LIMIT 400`, [tenantId, keys])).rows
  const crosses = rows.map((row: any) => ({
    code: String(row.code), brand: String(row.brand ?? ''), replacement_type: row.replacement_type ?? null,
    ours: ours.filter((p: any) => p.sku_key === row.code_key)
      .map((p: any) => ({ id: String(p.id), name: String(p.name), sku: p.sku, qty_on_hand: Number(p.qty_on_hand), retail_price: Number(p.retail_price) })),
    supplier: supplier.filter((o: any) => o.number_code === row.code_key && (!row.brand || !o.brand || upper(o.brand) === upper(row.brand)))
      .map((o: any) => ({ external_id: String(o.external_id), number: o.number, brand: o.brand, name: o.name, image_url: o.image_url,
        retail_price: Number(o.retail_price), ...(withPurchase ? { purchase_price: Number(o.purchase_price) } : {}), total_qty: Number(o.total_qty) })),
  }))
  return { query: needle, crosses: sortCrosses(crosses), pending }
}

/** Спершу те, що є в нас, потім те, що є в постачальника, потім решта кодів. */
export function sortCrosses<T extends { code: string; ours: Array<{ qty_on_hand: number }>; supplier: unknown[] }>(crosses: T[]): T[] {
  return [...crosses].sort((a, b) =>
    Number(b.ours.some(p => p.qty_on_hand > 0)) - Number(a.ours.some(p => p.qty_on_hand > 0))
    || Number(b.supplier.length > 0) - Number(a.supplier.length > 0)
    || a.code.localeCompare(b.code))
}

/** Скільки кросів одного товару переносимо в картку (захист від завеликих списків). */
export const CARD_CROSSES_MAX = 150

/**
 * 25.11.2026 (власник: «кроси мають працювати скрізь — і в пошуку по нашій базі товарів, щоб підтягувати інші
 * фільтри, які є в нас»): кроси й OE-номери товарів постачальника, що збіглися з НАШИМИ картками. Головний ПК
 * записує їх у крос-номери карток (джерело «omega») — і їх одразу бачать пошук, «Аналоги», каса, замовлення, навіть офлайн.
 * Порціями по 100 карток, у порядку часу отримання; found_at — позначка, з якої продовжувати.
 */
export async function linkedOfferCrossNumbers(tenantId: string, since: string | null) {
  const { rows } = await pool.query(
    `WITH ready AS (
       SELECT o.connection_id, o.external_id, o.product_id,
              GREATEST(COALESCE(o.crosses_checked_at, 'epoch'::timestamptz), COALESCE(o.details_checked_at, 'epoch'::timestamptz)) AS found_at
         FROM supplier_offers o
        WHERE o.tenant_id = $1 AND o.product_id IS NOT NULL AND (o.crosses_checked_at IS NOT NULL OR o.details_checked_at IS NOT NULL)
          AND GREATEST(COALESCE(o.crosses_checked_at, 'epoch'::timestamptz), COALESCE(o.details_checked_at, 'epoch'::timestamptz)) > COALESCE($2::timestamptz, 'epoch'::timestamptz)
        ORDER BY found_at LIMIT 100)
     SELECT r.product_id, r.found_at,
            COALESCE((SELECT json_agg(json_build_object('code', x.code, 'brand', NULLIF(x.brand, ''))) FROM supplier_offer_crosses x
                       WHERE x.connection_id = r.connection_id AND x.external_id = r.external_id), '[]'::json) AS crosses,
            COALESCE((SELECT json_agg(DISTINCT e.code) FROM supplier_offer_oe e
                       WHERE e.connection_id = r.connection_id AND e.external_id = r.external_id), '[]'::json) AS oe
       FROM ready r ORDER BY r.found_at`, [tenantId, since])
  return rows.map((row: any) => {
    const crosses = (Array.isArray(row.crosses) ? row.crosses : []).map((item: any) => ({ number: String(item.code), brand: item.brand ? String(item.brand) : null }))
    const oe = (Array.isArray(row.oe) ? row.oe : []).map((value: unknown) => ({ number: String(value), brand: null }))
    const seen = new Set<string>()
    const numbers = [...crosses, ...oe].filter(item => {
      const key = code(item.number)
      if (key.length < 3 || seen.has(key)) return false
      seen.add(key); return true
    }).slice(0, CARD_CROSSES_MAX)
    return { program_product_id: String(row.product_id), numbers, found_at: new Date(row.found_at).toISOString() }
  })
}
