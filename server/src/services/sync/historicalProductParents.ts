import { db } from '../../db/supabase.js'
import { AppError } from '../../middleware/errorHandler.js'
import { fetchAllByTimestamp } from '../syncKeyset.js'
import { IN_FILTER_CHUNK, isUuid } from './syncCore.js'

const fields = 'id,tenant_id,sku,name,barcode,brand_id,category_id,unit,purchase_price,retail_price,qty_on_hand,reorder_point,notes,is_active,is_service,storage_bin,is_favorite,photo_url,specs,requires_core_return,core_deposit_amount,created_at,updated_at,deleted_at'
const incomplete = () => new AppError('SYNC_HISTORY_INCOMPLETE',
  'Повна копія історії ще не готова: для документа відсутня картка товару. Повторіть отримання копії.', 409)

/** Carry tombstones needed by documents, without restoring them to the catalog.
 * Only the explicit owner bootstrap uses this; the active browser catalog does not. */
export async function includeHistoricalProductParents(
  tenantId: string, products: any[], groups: any[][], upperBound: string,
): Promise<any[]> {
  const known = new Set(products.map(row => row.id))
  const missing = [...new Set(groups.flatMap(rows => rows.map(row => row.product_id))
    .filter(id => id != null && !known.has(id)))]
  if (missing.some(id => !isUuid(id))) throw incomplete()
  const extra = new Map<string, any>()
  for (let start = 0; start < missing.length; start += IN_FILTER_CHUNK) {
    const ids = missing.slice(start, start + IN_FILTER_CHUNK)
    const requested = new Set(ids)
    const rows = await fetchAllByTimestamp(() => db.from('products').select(fields)
      .eq('tenant_id', tenantId).in('id', ids).not('deleted_at', 'is', null),
    { timestampColumn: 'updated_at', upperBound })
    for (const row of rows) {
      if (row.tenant_id !== tenantId || !requested.has(row.id) || !row.deleted_at || extra.has(row.id)) throw incomplete()
      extra.set(row.id, row)
    }
    if (ids.some(id => !extra.has(id))) throw incomplete()
  }
  return [...products, ...extra.values()]
}
