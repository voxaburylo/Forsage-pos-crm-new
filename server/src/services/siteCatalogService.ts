import { z } from 'zod'
import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { categoryRows, categorySubtree } from './siteCatalogCategories.js'

/**
 * 26.11.2026, слово власника: «у вкладці “Сайт” хай будуть ще всі товари — і наші, і від постачальників — у купі,
 * для зручності перегляду, редагування, додавання штрихкоду, масової роботи з товарами й цінами; міні-фото; усі
 * основні дані — в один рядок, решта — у картці; видаляти теж можна».
 *
 * Наші товари — з хмарної копії каталогу (каса головна: правки й видалення йдуть через головний ПК, як у «Товарах»).
 * Товари постачальників — з хмари; змінюються лише наші поля поверх прайсу (назва, штрихкод, ціна, «прибрано»),
 * бо прайс постачальника кожні 3 год перезаписує свої. «Видалити» товар постачальника = прибрати з сайту й підказок:
 * інакше наступний прайс поверне його знову.
 * Закупівельна ціна — лише власнику, адміністратору й менеджеру. Ціна для сайту ніколи не нижча за закупівельну.
 */
export const catalogQuerySchema = z.object({
  q: z.string().trim().max(120).optional().default(''),
  source: z.enum(['all', 'ours', 'supplier']).default('all'),
  flag: z.enum(['', 'no_barcode', 'no_photo', 'hidden', 'no_stock']).default(''),
  // 26.11.2026: категорія програми (разом із вкладеними) або 'none' — «Без категорії»; порожньо — усі товари.
  category: z.union([z.literal(''), z.literal('none'), z.string().uuid()]).optional().default(''),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  per_page: z.coerce.number().int().min(10).max(200).default(50),
})
export type CatalogQuery = z.infer<typeof catalogQuerySchema>

export const SEES_PURCHASE = new Set(['owner', 'admin', 'manager'])

export type CatalogRow = {
  kind: 'ours' | 'supplier'; id: string; sku: string | null; name: string; brand: string | null; barcode: string | null
  price: number; purchase?: number | null; qty: number; photo: string | null; category: string | null; supplier: string | null
  hidden: boolean; linked: boolean; custom: boolean
}

/** Пошук: слова з пробілами шукаються кожне окремо в назві, артикулі й штрихкоді («фільтр mann 712»). */
export function searchTerms(q: string): string[] {
  return q.toLowerCase().replace(/[%_\\]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6)
}

/** Вираз пошуку товару постачальника — той самий, що в індексі idx_supplier_offers_search_trgm (інакше індекс не працює). */
export const OFFER_SEARCH_EXPR = "lower(COALESCE(o.custom_name, o.name) || ' ' || COALESCE(o.number, '') || ' ' || COALESCE(o.custom_barcode, o.barcode, ''))"
/** Сортування за назвою — той самий вираз, що в індексах idx_products_tenant_lower_name / idx_supplier_offers_tenant_name. */
const OURS_ORDER = 'lower(p.name), p.id'
const OFFERS_ORDER = 'lower(COALESCE(o.custom_name, o.name)), o.external_id'

/** Вибрана категорія: список id (сама + вкладені), 'none' або нічого. */
type CategoryPick = string[] | 'none' | null

function sourceFilters(kind: 'ours' | 'supplier', terms: string[], flag: CatalogQuery['flag'], params: unknown[], category: CategoryPick = null): string[] {
  const where: string[] = []
  const alias = kind === 'ours' ? 'p' : 'o'
  if (Array.isArray(category)) { params.push(category); where.push(`${alias}.category_id = ANY($${params.length}::uuid[])`) }
  if (category === 'none') where.push(`(${alias}.category_id IS NULL OR NOT EXISTS (SELECT 1 FROM categories cx WHERE cx.id = ${alias}.category_id AND cx.deleted_at IS NULL))`)
  for (const term of terms) {
    params.push('%' + term + '%')
    where.push(kind === 'ours' ? `p.search_text ILIKE $${params.length}` : `${OFFER_SEARCH_EXPR} LIKE $${params.length}`)
  }
  const column = (ours: string, offer: string) => kind === 'ours' ? ours : offer
  if (flag === 'no_barcode') where.push(`COALESCE(${column('p.barcode', 'COALESCE(o.custom_barcode, o.barcode)')}, '') = ''`)
  if (flag === 'no_photo') where.push(`COALESCE(${column('p.photo_url', 'o.image_url')}, '') = ''`)
  if (flag === 'hidden') where.push(kind === 'ours' ? 'false' : 'o.hidden')
  if (flag === 'no_stock') where.push(`${column('p.qty_on_hand', 'o.total_qty')} <= 0`)
  return where
}

/**
 * Наші товари йдуть першими, далі — постачальників (кожна частина за назвою). Два окремі запити з індексами
 * замість одного обʼєднаного: сторінка не сортує 96 тис. рядків, а бере потрібний шматок з кожної частини.
 */
export async function listSiteCatalog(tenantId: string, role: string, query: CatalogQuery): Promise<{ rows: CatalogRow[]; total: number; page: number; pages: number; ours_total: number }> {
  const terms = searchTerms(query.q)
  const size = query.per_page
  const offset = (query.page - 1) * size
  const wantOurs = query.source !== 'supplier', wantOffers = query.source !== 'ours'
  const category: CategoryPick = query.category === 'none' ? 'none' : query.category ? categorySubtree(await categoryRows(tenantId), query.category) : null

  const oursParams: unknown[] = [tenantId]
  const oursWhere = ['p.tenant_id = $1', 'p.deleted_at IS NULL', ...sourceFilters('ours', terms, query.flag, oursParams, category)].join(' AND ')
  const offersParams: unknown[] = [tenantId]
  const offersWhere = ['o.tenant_id = $1', ...sourceFilters('supplier', terms, query.flag, offersParams, category)].join(' AND ')

  const [oursTotal, offersTotal] = await Promise.all([
    wantOurs ? pool.query(`SELECT count(*)::int AS n FROM products p WHERE ${oursWhere}`, oursParams).then(r => Number(r.rows[0]?.n ?? 0)) : Promise.resolve(0),
    wantOffers ? pool.query(`SELECT count(*)::int AS n FROM supplier_offers o WHERE ${offersWhere}`, offersParams).then(r => Number(r.rows[0]?.n ?? 0)) : Promise.resolve(0),
  ])
  const rows: any[] = []
  if (wantOurs && offset < oursTotal) {
    const { rows: found } = await pool.query(
      `SELECT 'ours' AS kind, p.id::text AS id, p.sku, p.name, b.name AS brand, p.barcode, p.retail_price AS price, p.purchase_price AS purchase,
              p.qty_on_hand AS qty, p.photo_url AS photo, c.name AS category, NULL AS supplier, false AS hidden, false AS linked, false AS custom
         FROM products p LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN categories c ON c.id = p.category_id
        WHERE ${oursWhere} ORDER BY ${OURS_ORDER} LIMIT ${size} OFFSET ${offset}`, oursParams)
    rows.push(...found)
  }
  const left = size - rows.length
  if (wantOffers && left > 0) {
    const offersOffset = Math.max(0, offset - oursTotal)
    const { rows: found } = await pool.query(
      `SELECT 'supplier' AS kind, o.connection_id::text || ':' || o.external_id AS id, o.number AS sku, COALESCE(o.custom_name, o.name) AS name, o.brand,
              COALESCE(o.custom_barcode, o.barcode) AS barcode, COALESCE(o.custom_price, o.retail_price) AS price, o.purchase_price AS purchase,
              o.total_qty AS qty, o.image_url AS photo, COALESCE(oc.name, o.category_name) AS category, sc.name AS supplier, o.hidden, o.product_id IS NOT NULL AS linked,
              (o.custom_name IS NOT NULL OR o.custom_barcode IS NOT NULL OR o.custom_price IS NOT NULL) AS custom
         FROM supplier_offers o JOIN supplier_api_connections sc ON sc.id = o.connection_id
         LEFT JOIN categories oc ON oc.id = o.category_id AND oc.deleted_at IS NULL
        WHERE ${offersWhere} ORDER BY ${OFFERS_ORDER} LIMIT ${left} OFFSET ${offersOffset}`, offersParams)
    rows.push(...found)
  }
  const total = oursTotal + offersTotal
  const purchase = SEES_PURCHASE.has(role)
  return {
    total, ours_total: oursTotal, page: query.page, pages: Math.max(1, Math.ceil(total / size)),
    rows: rows.map((row: any) => ({
      kind: row.kind, id: row.id, sku: row.sku, name: row.name, brand: row.brand, barcode: row.barcode,
      price: Number(row.price) || 0, ...(purchase ? { purchase: row.purchase == null ? null : Number(row.purchase) } : {}),
      qty: Number(row.qty) || 0, photo: row.photo, category: row.category, supplier: row.supplier,
      hidden: Boolean(row.hidden), linked: Boolean(row.linked), custom: Boolean(row.custom),
    })),
  }
}

const OFFER_KEY = /^([0-9a-f-]{36}):(.{1,80})$/
export function parseOfferKey(key: string): { connectionId: string; externalId: string } {
  const match = OFFER_KEY.exec(String(key))
  if (!match) throw new AppError('VALIDATION_ERROR', 'Некоректний товар постачальника', 422)
  return { connectionId: match[1], externalId: match[2] }
}

/** Картка товару постачальника: усе, що є, включно зі складами (назва складу, кількість, днів до відправки). */
export async function getSupplierOffer(tenantId: string, role: string, key: string) {
  const { connectionId, externalId } = parseOfferKey(key)
  const { rows } = await pool.query(
    `SELECT o.*, sc.name AS supplier FROM supplier_offers o JOIN supplier_api_connections sc ON sc.id = o.connection_id
      WHERE o.tenant_id = $1 AND o.connection_id = $2 AND o.external_id = $3`, [tenantId, connectionId, externalId])
  const row = rows[0]
  if (!row) throw new AppError('NOT_FOUND', 'Товар постачальника не знайдено', 404)
  const warehouses = (await pool.query('SELECT code, name, days_to_ship, is_active FROM supplier_warehouses WHERE connection_id = $1', [connectionId])).rows
  const byCode = new Map(warehouses.map((w: any) => [String(w.code), w]))
  const stock = (Array.isArray(row.stock) ? row.stock : []).map((s: any) => {
    const w: any = byCode.get(String(s?.w))
    return { warehouse: w?.name ?? String(s?.w ?? ''), qty: Number(s?.q) || 0, days_to_ship: w?.days_to_ship ?? null, active: w ? Boolean(w.is_active) : true }
  }).filter((s: { qty: number }) => s.qty > 0)
  return {
    key, supplier: row.supplier, number: row.number, brand: row.brand, name: row.name, custom_name: row.custom_name,
    barcode: row.barcode, custom_barcode: row.custom_barcode, retail_price: Number(row.retail_price) || 0, custom_price: row.custom_price == null ? null : Number(row.custom_price),
    ...(SEES_PURCHASE.has(role) ? { purchase_price: Number(row.purchase_price) || 0 } : {}),
    hidden: Boolean(row.hidden), image_url: row.image_url, description: row.description, category_name: row.category_name,
    total_qty: Number(row.total_qty) || 0, stock, product_id: row.product_id, updated_at: row.updated_at,
  }
}

export const offerPatchSchema = z.object({
  custom_name: z.string().trim().min(1).max(400).nullable().optional(),
  custom_barcode: z.string().trim().regex(/^[0-9A-Za-z-]{4,64}$/, 'Штрихкод: 4–64 цифри чи латинські літери').nullable().optional(),
  custom_price: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  hidden: z.boolean().optional(),
})

export async function patchSupplierOffer(tenantId: string, key: string, patch: z.infer<typeof offerPatchSchema>): Promise<void> {
  const { connectionId, externalId } = parseOfferKey(key)
  const current = (await pool.query('SELECT purchase_price FROM supplier_offers WHERE tenant_id = $1 AND connection_id = $2 AND external_id = $3', [tenantId, connectionId, externalId])).rows[0]
  if (!current) throw new AppError('NOT_FOUND', 'Товар постачальника не знайдено', 404)
  if (patch.custom_price != null && patch.custom_price < Number(current.purchase_price))
    throw new AppError('PRICE_BELOW_PURCHASE', 'Ціна нижча за закупівельну — так продавати не можна.', 422)
  const sets: string[] = [], params: unknown[] = [tenantId, connectionId, externalId]
  for (const field of ['custom_name', 'custom_barcode', 'custom_price', 'hidden'] as const) {
    if (patch[field] === undefined) continue
    params.push(patch[field]); sets.push(`${field} = $${params.length}`)
  }
  if (!sets.length) return
  await pool.query(`UPDATE supplier_offers SET ${sets.join(', ')}, updated_at = now() WHERE tenant_id = $1 AND connection_id = $2 AND external_id = $3`, params)
}

export const offerBulkSchema = z.object({
  keys: z.array(z.string().min(3).max(160)).min(1).max(5000),
  hidden: z.boolean().optional(),
  /** Зміна ціни у відсотках від поточної ціни сайту, напр. 10 або -5. */
  price_pct: z.number().min(-90).max(500).optional(),
  /** Повернути ціну за сіткою націнок (прибрати власну). */
  reset_price: z.boolean().optional(),
})

/** Масово: прибрати/повернути, ціна ±%, повернути ціну за сіткою. Рядки, де ціна впала б нижче закупки, не змінюються. */
export async function bulkSupplierOffers(tenantId: string, input: z.infer<typeof offerBulkSchema>): Promise<{ changed: number; below_purchase: number }> {
  const keys = input.keys.map(key => parseOfferKey(key)).map(key => key.connectionId + ':' + key.externalId)
  let changed = 0, below = 0
  if (input.hidden !== undefined) {
    changed += (await pool.query(`UPDATE supplier_offers SET hidden = $3, updated_at = now() WHERE tenant_id = $1 AND connection_id::text || ':' || external_id = ANY($2)`, [tenantId, keys, input.hidden])).rowCount ?? 0
  }
  if (input.reset_price) {
    changed += (await pool.query(`UPDATE supplier_offers SET custom_price = NULL, updated_at = now() WHERE tenant_id = $1 AND connection_id::text || ':' || external_id = ANY($2) AND custom_price IS NOT NULL`, [tenantId, keys])).rowCount ?? 0
  }
  if (input.price_pct !== undefined && input.price_pct !== 0) {
    const factor = 1 + input.price_pct / 100
    // Округлення вгору до 5 грн (500 коп.), як у сітці націнок.
    const next = `(ceil(COALESCE(custom_price, retail_price) * $3 / 500.0) * 500)::bigint`
    below = Number((await pool.query(`SELECT count(*)::int AS n FROM supplier_offers WHERE tenant_id = $1 AND connection_id::text || ':' || external_id = ANY($2) AND ${next} < purchase_price`, [tenantId, keys, factor])).rows[0]?.n ?? 0)
    changed += (await pool.query(`UPDATE supplier_offers SET custom_price = ${next}, updated_at = now()
      WHERE tenant_id = $1 AND connection_id::text || ':' || external_id = ANY($2) AND ${next} >= purchase_price`, [tenantId, keys, factor])).rowCount ?? 0
  }
  return { changed, below_purchase: below }
}
