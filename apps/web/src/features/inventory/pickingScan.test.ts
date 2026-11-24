import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { exactScanProducts, findScanTarget, scanResultText } from './pickingScan'
import type { EnrichedCustomerOrder } from './pickingApi'

const order = (id: string, created: string, items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
  id, created_at: created, order_number: Number(id.replace(/\D/g, '')) || null, pickup_cell: null, customer: { full_name: 'Іван', phone: '0501234567' },
  items: items.map((item, index) => ({ id: id + '-' + index, order_id: id, name: 'Фільтр', sku: null, product_id: null, supplier_id: null, source_type: 'supplier',
    item_status: 'ordered', buy_price: 0, sell_price: 0, qty: 1, expected_date: null, storage_bin: null, ...item })), ...over,
}) as unknown as EnrichedCustomerOrder

// 24.11.2026 (слово власника): сканувати прибулий товар у «Збірці замовлень», за бажанням.
describe('scanning arrived goods in order picking', () => {
  const orders = [
    order('o2', '2026-11-22T10:00:00Z', [{ sku: 'KCF-8113', name: 'Фільтр салона' }], { pickup_cell: 'B-3' }),
    order('o1', '2026-11-20T10:00:00Z', [{ product_id: 'p1', name: 'Колодки' }, { sku: 'kcf 8113', name: 'Фільтр салона' }], { pickup_cell: 'A-12' }),
    order('o3', '2026-11-23T10:00:00Z', [{ product_id: 'p1', name: 'Колодки', item_status: 'arrived' }, { sku: 'X-1', item_status: 'canceled' }]),
  ]

  it('finds the oldest order waiting for the goods by the card or by the article and says how many more wait', () => {
    const byCard = findScanTarget(orders, '4820001', ['p1'])!
    expect([byCard.order.id, byCard.item.name, byCard.moreWaiting]).toEqual(['o1', 'Колодки', 0])
    const bySku = findScanTarget(orders, 'KCF8113', [])!
    expect([bySku.order.id, bySku.moreWaiting]).toEqual(['o1', 1])
    expect(scanResultText(bySku)).toEqual({ title: 'Фільтр салона — 1 шт', where: 'Замовлення № 1 · Іван',
      more: 'Цей товар чекає ще 1 поз. в інших замовленнях — відскануйте наступну штуку.' })
  })

  it('never guesses: arrived, cancelled, similar or too short codes give nothing', () => {
    expect(findScanTarget(orders, 'X-1', [])).toBeNull()
    expect(findScanTarget(orders, 'KCF-811', [])).toBeNull()
    expect(findScanTarget(orders, '12', ['p1'])).toBeNull()
    expect(findScanTarget(orders, '4820009', ['p9'])).toBeNull()
  })

  it('a card matches only by its exact barcode, extra barcode or article', () => {
    const cards = [{ id: 'a', sku: 'WB-1065', barcode: '4820001', additional_barcodes: ['2000998780791'] }, { id: 'b', sku: 'WB-10650', barcode: '48200010' }]
    expect(exactScanProducts('4820001', cards)).toEqual(['a'])
    expect(exactScanProducts('2000998780791', cards)).toEqual(['a'])
    expect(exactScanProducts('wb 1065', cards)).toEqual(['a'])
    expect(exactScanProducts('482000', cards)).toEqual([])
  })

  it('the scanner is optional: the panel is folded until asked for and lives on the picking list', () => {
    const panel = readFileSync(new URL('./PickingScanPanel.tsx', import.meta.url), 'utf8')
    expect(panel).toContain('const [open, setOpen] = useState(false)')
    expect(panel).toContain("pickingApi.pickItem(target.item.id, 'arrived')")
    expect(readFileSync(new URL('./WarehousePicking.tsx', import.meta.url), 'utf8')).toContain('<PickingScanPanel orders={orders} onChanged={loadOrders} />')
  })
})
