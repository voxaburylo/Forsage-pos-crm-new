import { describe, expect, it } from 'vitest'
import { catalogComparator, hasAvailableStock } from './catalogOrder'

describe('offline cache stock-first sorting', () => {
  it.each(['name', 'brand', 'qty_on_hand', 'retail_price', 'sku'])(
    'groups the entire cache before taking pages, including %s sorting', (sortField) => {
      const products = Array.from({ length: 700 }, (_, i) => ({
        id: String(i), name: `Фільтр ${i}`, sku: `SKU-${i}`, retail_price: 700 - i,
        qty_on_hand: 10, qty_available: i % 3 ? 10 : 0,
        brand: { name: `Бренд ${i % 7}` },
      }))
      const sorted = [...products].sort(catalogComparator({ sortField, sortDir: 'desc' }))
      const firstAbsent = sorted.findIndex(p => !hasAvailableStock(p))
      expect(firstAbsent).toBe(466)
      expect(sorted.slice(firstAbsent).some(hasAvailableStock)).toBe(false)
      expect(sorted.slice(400, 500).filter(hasAvailableStock)).toHaveLength(66)
    },
  )
  it('treats services as available and keeps exact but absent matches below available goods', () => {
    const rows = [
      { id: 'absent', sku: 'filter', name: 'A', qty_on_hand: 0 },
      { id: 'stock', sku: 'filter-2', name: 'Z', qty_on_hand: 1 },
      { id: 'service', name: 'B', qty_on_hand: 0, is_service: true },
    ].sort(catalogComparator({ search: 'filter' }))
    expect(rows.map(p => p.id)).toEqual(['service', 'stock', 'absent'])
  })
})
