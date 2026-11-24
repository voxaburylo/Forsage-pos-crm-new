import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groupRestock, initialPick, NO_SUPPLIER, readPickQty, restockFileName, restockSheetRows, restockText, type RestockRow } from './restockModel'

const row = (id: string, over: Partial<RestockRow> = {}): RestockRow => ({ product_id: id, sku: 'S-' + id, name: 'Товар ' + id, qty_on_hand: 0, reorder_point: 0,
  sold_30: 1, sold_90: 2, purchase_price: 10000, suggest_qty: 1, supplier_id: 'v', supplier_name: 'Vitol', last_received_at: null, ...over })

// 24.11.2026 (слово власника): товари з низьким залишком за постачальниками → лист замовлення текстом або Excel.
describe('restock list by supplier', () => {
  const rows = [
    row('1', { qty_on_hand: 2, sold_30: 9, suggest_qty: 7 }), row('2', { sold_30: 1 }), row('3', { sold_30: 5, suggest_qty: 5 }),
    row('4', { supplier_id: null, supplier_name: null }), row('5', { supplier_id: 'a', supplier_name: 'Автотехнікс', suggest_qty: 2 }),
  ]

  it('groups by supplier in alphabetical order, unknown supplier last; out-of-stock and fast sellers first', () => {
    const groups = groupRestock(rows)
    expect(groups.map(group => group.title)).toEqual(['Автотехнікс', 'Vitol', NO_SUPPLIER].sort((a, b) => a === NO_SUPPLIER ? 1 : b === NO_SUPPLIER ? -1 : a.localeCompare(b, 'uk')))
    expect(groups.at(-1)!.title).toBe(NO_SUPPLIER)
    const vitol = groups.find(group => group.supplier_id === 'v')!
    expect(vitol.rows.map(item => item.product_id)).toEqual(['3', '2', '1'])
    expect(vitol.total).toBe(7 * 10000 + 10000 + 5 * 10000)
  })

  it('the order sheet has article, name and quantity — no prices, no stock; zero quantity drops the row', () => {
    const vitol = groupRestock(rows).find(group => group.supplier_id === 'v')!
    const picked = initialPick(rows); picked.set('2', 0); picked.set('1', 2.5)
    expect(restockText(vitol, picked)).toBe('Замовлення від Форсаж:\n1. S-3 — Товар 3 × 5\n2. S-1 — Товар 1 × 2.5')
    expect(restockSheetRows(vitol, picked)).toEqual([
      { '№': 1, 'Артикул': 'S-3', 'Назва': 'Товар 3', 'Кількість': 5 }, { '№': 2, 'Артикул': 'S-1', 'Назва': 'Товар 1', 'Кількість': 2.5 }])
    expect(restockText(vitol, new Map())).toBe('')
  })

  it('reads the quantity field safely and names the file without forbidden characters', () => {
    expect(['3', ' 2,5 ', '', 'abc', '-1', '1e9'].map(readPickQty)).toEqual([3, 2.5, 0, 0, 0, 0])
    expect(restockFileName('ТОВ "Омега": авто/запчастини', new Date(2026, 10, 24))).toBe('Замовлення-ТОВ Омега авто запчастини-2026-11-24.xlsx')
    expect(restockFileName('  ', new Date(2026, 0, 5))).toBe('Замовлення-постачальник-2026-01-05.xlsx')
  })

  it('is the first tab of Auto-purchase and only reads from the till', () => {
    const page = readFileSync(new URL('./AutoPurchasePage.tsx', import.meta.url), 'utf8')
    expect(page).toContain("useState<'restock' | 'suggestions' | 'rules'>('restock')")
    expect(page).toContain("tab === 'restock' ? <RestockTab />")
    const tab = readFileSync(new URL('./RestockTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('purchaseApi.restockNeeds()')
    expect(tab).not.toMatch(/purchaseApi\.(create|update|delete|save)/)
  })
})
