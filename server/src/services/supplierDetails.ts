import { pool, runTransaction } from '../db/pg.js'
import { code, omegaCall, takeCall, type OmegaDeps } from './supplierApiService.js'

/**
 * Опис товарів постачальника. Слово власника 25.11.2026: «усе, що можна витягнути по API, — витягуй».
 * Омега /product/details приймає список товарів і на кожен віддає: OE-номери з моделлю авто, застосовність
 * (дерево авто) і характеристики. Суцільного тексту-опису й схем в API немає.
 * Пачкою — тому ліміт майже не витрачається: DETAILS_BATCH товарів за запит, один запит за прохід планувальника.
 */
export const DETAILS_BATCH = 20
export const DETAILS_CALLS_PER_RUN = 1

export interface OfferDetails {
  external_id: string
  oe_codes: Array<{ code: string; code_key: string; car_model: string }>
  applicability: unknown[]
  specifications: Array<{ key: string; value: string; descr: string | null }>
}

const text = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max)

/** Дерево застосовності: лише назви, не глибше 6 рівнів і не більше 2000 вузлів (захист від завеликої відповіді). */
export function applicabilityTree(value: unknown, depth = 0, budget = { left: 2000 }): Array<{ name: string; children: unknown[] }> {
  if (!Array.isArray(value) || depth > 6) return []
  const nodes: Array<{ name: string; children: unknown[] }> = []
  for (const raw of value) {
    if (budget.left <= 0) break
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const name = text(item.Name, 200)
    if (!name) continue
    budget.left -= 1
    nodes.push({ name, children: applicabilityTree(item.Children, depth + 1, budget) })
  }
  return nodes
}

/** Відповідь Омеги → опис по кожному товару. Товари без ProductId відкидаються. */
export function detailsRows(data: unknown): OfferDetails[] {
  const rows: OfferDetails[] = []
  for (const raw of Array.isArray(data) ? data : []) {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const id = text(item.ProductId, 80)
    if (!/^-?\d{1,15}$/.test(id)) continue
    const seen = new Set<string>()
    const oe = (Array.isArray(item.OECodeList) ? item.OECodeList : []).flatMap((entry: any) => {
      const value = text(entry?.Code, 120), key = code(value).slice(0, 120), car = text(entry?.CarModel, 200)
      if (!key || seen.has(key + '|' + car)) return []
      seen.add(key + '|' + car)
      return [{ code: value, code_key: key, car_model: car }]
    }).slice(0, 500)
    const specifications = (Array.isArray(item.SpecificationList) ? item.SpecificationList : []).flatMap((entry: any) => {
      const key = text(entry?.Key, 200), value = text(entry?.Value, 500)
      return key || value ? [{ key, value, descr: text(entry?.Descr, 500) || null }] : []
    }).slice(0, 200)
    rows.push({ external_id: id, oe_codes: oe, applicability: applicabilityTree(item.ApplicabilityList), specifications })
  }
  return rows
}

export async function omegaDetails(key: string, productIds: string[], deps: OmegaDeps = {}): Promise<OfferDetails[]> {
  const ids = productIds.filter(id => /^-?\d{1,15}$/.test(id)).map(Number)
  if (!ids.length) return []
  const answer = await omegaCall<{ Data?: unknown }>('/product/details', key, { ProductIdList: ids }, deps, 60_000)
  return detailsRows(answer.Data)
}

type Connection = { id: string; tenant_id: string; api_key: string }

/** Запитати й зберегти опис пачки товарів. false — ліміт запитів вичерпано. */
export async function fetchOfferDetails(connection: Connection, externalIds: string[], deps: OmegaDeps = {}): Promise<boolean> {
  if (!externalIds.length) return true
  if (!await takeCall(connection.id)) return false
  const details = await omegaDetails(connection.api_key, externalIds, deps)
  await runTransaction(async client => {
    for (const row of details) {
      await client.query(
        `INSERT INTO supplier_offer_details (tenant_id, connection_id, external_id, oe_codes, applicability, specifications, fetched_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, now())
         ON CONFLICT (connection_id, external_id) DO UPDATE SET oe_codes = EXCLUDED.oe_codes, applicability = EXCLUDED.applicability,
           specifications = EXCLUDED.specifications, fetched_at = now()`,
        [connection.tenant_id, connection.id, row.external_id, JSON.stringify(row.oe_codes), JSON.stringify(row.applicability), JSON.stringify(row.specifications)])
      await client.query('DELETE FROM supplier_offer_oe WHERE connection_id = $1 AND external_id = $2', [connection.id, row.external_id])
      for (const oe of row.oe_codes) {
        await client.query(
          `INSERT INTO supplier_offer_oe (tenant_id, connection_id, external_id, code, code_key, car_model) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [connection.tenant_id, connection.id, row.external_id, oe.code, oe.code_key, oe.car_model])
      }
    }
    // Позначаємо всю пачку: товар, про який Омега нічого не сказала, теж не питаємо щоразу.
    await client.query('UPDATE supplier_offers SET details_checked_at = now() WHERE connection_id = $1 AND external_id = ANY($2::text[])', [connection.id, externalIds])
  })
  return true
}

/** Фоном — опис усіх товарів, пачками: спершу наші картки, далі ті, що в наявності. */
export async function syncDetailsStep(connection: Connection, deps: OmegaDeps = {}, calls = DETAILS_CALLS_PER_RUN) {
  let fetched = 0
  for (let call = 0; call < calls; call += 1) {
    const { rows } = await pool.query(
      `SELECT external_id FROM supplier_offers WHERE connection_id = $1 AND details_checked_at IS NULL
       ORDER BY (product_id IS NOT NULL) DESC, total_qty DESC, external_id LIMIT $2`, [connection.id, DETAILS_BATCH])
    if (!rows.length) break
    if (!await fetchOfferDetails(connection, rows.map((row: any) => String(row.external_id)), deps)) return { fetched, stopped: 'limit' as const }
    fetched += rows.length
  }
  return { fetched, stopped: null }
}

/** Опис товару постачальника за артикулом (для картки товару): характеристики, OE-номери, застосовність. */
export async function searchDetails(tenantId: string, query: string, deps: OmegaDeps = {}) {
  const needle = code(query)
  if (needle.length < 3) return { query: needle, items: [], pending: false }
  const offers = (await pool.query(
    `SELECT o.connection_id, o.external_id, o.number, o.brand, o.name, o.details_checked_at, c.tenant_id, c.api_key
       FROM supplier_offers o JOIN supplier_api_connections c ON c.id = o.connection_id AND c.enabled
      WHERE o.tenant_id = $1 AND o.number_code = $2 ORDER BY o.total_qty DESC LIMIT 3`, [tenantId, needle])).rows
  let pending = false
  const missing = offers.filter((offer: any) => !offer.details_checked_at)
  if (missing.length) {
    try {
      const first = missing[0]
      if (!await fetchOfferDetails({ id: first.connection_id, tenant_id: first.tenant_id, api_key: first.api_key },
        missing.filter((offer: any) => offer.connection_id === first.connection_id).map((offer: any) => String(offer.external_id)), deps)) pending = true
    } catch { pending = true }
  }
  if (!offers.length) return { query: needle, items: [], pending }
  const details = (await pool.query(
    `SELECT connection_id, external_id, oe_codes, applicability, specifications FROM supplier_offer_details
      WHERE tenant_id = $1 AND (connection_id, external_id) IN (SELECT unnest($2::uuid[]), unnest($3::text[]))`,
    [tenantId, offers.map((offer: any) => offer.connection_id), offers.map((offer: any) => String(offer.external_id))])).rows
  const items = offers.flatMap((offer: any) => {
    const found = details.find((row: any) => row.connection_id === offer.connection_id && row.external_id === String(offer.external_id))
    return found ? [{ number: offer.number, brand: offer.brand, name: offer.name, oe_codes: found.oe_codes ?? [], applicability: found.applicability ?? [], specifications: found.specifications ?? [] }] : []
  })
  return { query: needle, items, pending }
}
