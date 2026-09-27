import type { SoldItem } from '@/types/report'

export const UNKNOWN_SUPPLIER = '__unknown__'
export const supplierReportNote = 'Постачальники — з проведених приходів за весь час. Товар від кількох постачальників доступний у списку кожного; це список для замовлення, не облік проданих партій.'
export function soldSupplierOptions(items: SoldItem[]) {
  const options = new Map<string, string>()
  for (const item of items) for (const supplier of item.suppliers ?? []) options.set(supplier.id, supplier.name)
  return [...options].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'uk') || a.id.localeCompare(b.id))
}
export function filterSoldBySupplier(items: SoldItem[], supplierId: string) {
  if (!supplierId) return items
  if (supplierId === UNKNOWN_SUPPLIER) return items.filter(item => item.suppliers?.length === 0)
  return items.filter(item => item.suppliers?.some(supplier => supplier.id === supplierId))
}
export function soldSupplierNames(item: SoldItem) {
  return item.suppliers === undefined ? 'Дані недоступні' : item.suppliers.map(supplier => supplier.name).join(', ') || 'Не визначено'
}
export function soldReorderExport(items: SoldItem[], supplierLabel: string) {
  return items.map(item => ({
    'Постачальник у звіті': supplierLabel,
    'Постачальники товару': soldSupplierNames(item),
    'Артикул': item.sku,
    'Штрихкод': item.barcode || '',
    'Назва': item.name,
    'Чисто продано': item.qty_net,
    'Одиниця': item.unit,
    'Залишок зараз': item.qty_on_hand,
    'Полиця': item.storage_bin || '',
    'Чиста сума (грн)': item.net_revenue / 100,
  }))
}
