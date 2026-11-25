import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { crossChips } from './SupplierCrossHints'

// 25.11.2026: у бланку замовлення — аналоги з кросів Омеги; натиск підставляє аналог у пошук.
describe('cross hints in the order form', () => {
  it('shows each analog with how many we and Omega have', () => {
    expect(crossChips({ query: 'Q', pending: false, crosses: [{ code: 'OC90', brand: 'Knecht', replacement_type: null,
      ours: [{ id: 'p', name: 'n', sku: 'OC90', qty_on_hand: 3, retail_price: 1 }],
      supplier: [{ external_id: '1', number: 'OC90', brand: 'Knecht', name: 'n', image_url: null, retail_price: 1, total_qty: 7 }] }] }))
      .toEqual([{ code: 'OC90', brand: 'Knecht', ours: 3, supplier: 7 }])
    expect(crossChips(null)).toEqual([])
  })
  it('is in the order form under the supplier offers and fills the search box', () => {
    const form = readFileSync(new URL('./OrderFormPage.tsx', import.meta.url), 'utf8')
    expect(form).toContain('<SupplierCrossHints query={search} onSearch={setSearch} />')
  })
})
