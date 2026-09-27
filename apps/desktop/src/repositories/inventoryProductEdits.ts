import type { LocalDatabase } from '../db/localDatabase'
import type { LocalProductUpsert } from '../db/localTypes'
import { LocalCatalogRepository } from './catalogRepository'

export type InventoryProductField = 'name' | 'sku' | 'retail_price' | 'purchase_price'
export interface InventoryProductEdit {
  product_id: string
  values: Partial<Record<InventoryProductField, string | number>>
  base: Partial<Record<InventoryProductField, string | number>>
}
const allowed = new Set(['name', 'sku', 'retail_price', 'purchase_price'])

/** Called within the inventory transaction. Only explicit fields can change. */
export function applyInventoryProductEdits(db: LocalDatabase, tenantId: string, edits: InventoryProductEdit[]): any[] {
  if (!Array.isArray(edits) || !edits.length || edits.length > 5000) throw new Error('Перевірте список товарів для зміни')
  const seen = new Set<string>(), catalog = new LocalCatalogRepository(db), result: any[] = []
  for (const edit of edits) {
    if (!edit || !edit.product_id || seen.has(edit.product_id)) throw new Error('Товар у списку змін повторюється або відсутній')
    seen.add(edit.product_id)
    const keys = Object.keys(edit.values ?? {})
    if (!keys.length || keys.some(key => !allowed.has(key)) || !edit.base || Array.isArray(edit.base)
      || Object.keys(edit.base).some(key => !allowed.has(key))) throw new Error('Некоректні поля товару ревізії')
    const row = db.prepare('SELECT * FROM products WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND is_active = 1')
      .get(edit.product_id, tenantId) as any
    if (!row) throw new Error('Товар ревізії не знайдено або видалений')
    const values: Record<string, string | number> = {}
    for (const key of keys as InventoryProductField[]) {
      const raw = edit.values[key]
      if (key === 'retail_price' || key === 'purchase_price') {
        if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) throw new Error('Некоректна ціна товару')
        values[key] = raw
      } else {
        if (typeof raw !== 'string' || raw.trim().length < (key === 'name' ? 2 : 1)) throw new Error('Вкажіть назву та артикул товару')
        values[key] = raw.trim()
      }
      if (!Object.hasOwn(edit.base, key)) throw new Error('DOCUMENT_CONFLICT: Немає початкового значення поля. Звірте картку перед збереженням.')
    }
    for (const key of Object.keys(edit.base) as InventoryProductField[]) {
      if (row[key] !== edit.base[key] && row[key] !== values[key]) {
        throw new Error(`DOCUMENT_CONFLICT: Товар «${row.name}» уже змінено. Введене залишилось у полі; звірте актуальні дані.`)
      }
    }
    if (keys.some(key => row[key] !== values[key])) {
      const payload: LocalProductUpsert = {
        id: row.id, tenant_id: tenantId, sku: row.sku, name: row.name, barcode: row.barcode,
        brand_id: row.brand_id, category_id: row.category_id, unit: row.unit,
        purchase_price: row.purchase_price, retail_price: row.retail_price,
        reorder_point: row.reorder_point, notes: row.notes, storage_bin: row.storage_bin,
        photo_url: row.photo_url, core_deposit_amount: row.core_deposit_amount,
        is_active: Boolean(row.is_active), is_service: Boolean(row.is_service),
        is_favorite: Boolean(row.is_favorite), requires_core_return: Boolean(row.requires_core_return),
        specs: JSON.parse(row.specs_json || '{}'), ...values,
      }
      catalog.saveProduct(payload)
    }
    result.push(catalog.findById(row.id, tenantId))
  }
  return result
}
