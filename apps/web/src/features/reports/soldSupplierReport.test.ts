import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import type { SoldItem } from '@/types/report'
import { filterSoldBySupplier, soldSupplierOptions, soldSupplierNames, soldReorderExport, UNKNOWN_SUPPLIER } from './soldSupplierReport'
const a = { id: 'a', name: 'Автокомфорт' }
const b = { id: 'b', name: 'Інший' }
function item(id: string, suppliers: SoldItem['suppliers']): SoldItem {
  return { product_id: id, name: 'Фільтр ' + id, sku: '00123', barcode: '2000000000001', unit: 'шт', suppliers,
    qty_sold: 5, qty_returned: 1, qty_net: 4, revenue: 50000, refund_total: 10000, net_revenue: 40000, qty_on_hand: 2, storage_bin: null }
}
describe('supplier reorder reports', () => {
  const rows = [item('1', [a, b]), item('2', [a]), item('3', [])]
  it('does not duplicate products in all suppliers and preserves returned quantities', () => {
    expect(filterSoldBySupplier(rows, '')).toBe(rows)
    const filtered = filterSoldBySupplier(rows, 'a')
    expect(filtered.map(x => x.product_id)).toEqual(['1', '2'])
    expect(filtered.reduce((sum, x) => sum + x.qty_net, 0)).toBe(8)
    expect(filtered.reduce((sum, x) => sum + x.net_revenue, 0)).toBe(80000)
    expect(filterSoldBySupplier(rows, 'b')).toEqual([rows[0]])
  })
  it('distinguishes no supplier from an old backend with missing supplier data', () => {
    expect(filterSoldBySupplier([...rows, item('old', undefined)], UNKNOWN_SUPPLIER)).toEqual([rows[2]])
    expect(soldSupplierNames(rows[2])).toBe('Не визначено')
    expect(soldSupplierNames(item('old', undefined))).toBe('Дані недоступні')
    expect(filterSoldBySupplier(rows, 'absent')).toEqual([])
  })
  it('lists each supplier once and exports exactly the filtered rows with identifiers as text', () => {
    expect(soldSupplierOptions(rows)).toEqual([a, b])
    const exported = soldReorderExport(filterSoldBySupplier(rows, 'b'), b.name)
    expect(exported).toHaveLength(1)
    const sheet = XLSX.utils.json_to_sheet(exported)
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, sheet, 'Звіт')
    const reopened = XLSX.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' })
    const roundTrip = XLSX.utils.sheet_to_json(reopened.Sheets['Звіт'])
    expect(roundTrip).toEqual(exported)
    expect(exported[0]).toMatchObject({ 'Постачальник у звіті': b.name, 'Постачальники товару': 'Автокомфорт, Інший',
      'Чисто продано': 4, 'Залишок зараз': 2, 'Артикул': '00123', 'Чиста сума (грн)': 400 })
  })
})
