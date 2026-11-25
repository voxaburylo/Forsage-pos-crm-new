import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { crossSummary } from './SupplierCrossAnalogs'

// 25.11.2026: аналоги за кросами Омеги — у картці товару й у вікні «Аналоги» зі списку товарів.
describe('supplier cross analogs on screen', () => {
  it('summarizes how many crosses we and Omega have', () => {
    const cross = (ours: number[], supplier: number) => ({ code: 'X', brand: '', replacement_type: null,
      ours: ours.map(qty => ({ id: 'p', name: 'n', sku: 's', qty_on_hand: qty, retail_price: 1 })),
      supplier: Array.from({ length: supplier }, (_, i) => ({ external_id: String(i), number: 'X', brand: null, name: 'n', image_url: null, retail_price: 1, total_qty: 1 })) })
    expect(crossSummary({ query: 'Q', pending: false, crosses: [cross([2], 0), cross([], 1), cross([0], 0)] })).toBe('кросів 3 · у нас є 1 · в Омеги є 1')
  })
  it('is shown in the product card and in the analogs window of the list', () => {
    const stock = readFileSync(new URL('./StockAnalogs.tsx', import.meta.url), 'utf8')
    expect(stock).toContain('<SupplierCrossAnalogs sku={sku} />')
    expect(stock).toContain('<SupplierCrossAnalogs sku={sku} onLeave={() => setOpen(false)} />')
    expect(readFileSync(new URL('./ProductDetailPage.tsx', import.meta.url), 'utf8')).toContain('<StockAnalogsCard productId={product.id} sku={product.sku} />')
  })
})
