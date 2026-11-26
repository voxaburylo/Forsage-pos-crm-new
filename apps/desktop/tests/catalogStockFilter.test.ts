import { describe, expect, it } from 'vitest'
import { catalogStockFilterClause } from '../src/repositories/catalogStockFilter'

// 26.11.2026, слово власника: «у товарах — які в наявності, теж такий відбір».
describe('Products list: stock filter buttons', () => {
  it('in stock = more than zero on hand; the old filters stay as they were; nothing chosen — no filter', () => {
    expect(catalogStockFilterClause('in_stock')).toBe('p.qty_on_hand > 0')
    expect(catalogStockFilterClause('negative')).toBe('p.qty_on_hand < 0')
    expect(catalogStockFilterClause('no_price')).toBe('p.retail_price = 0')
    expect(catalogStockFilterClause('')).toBeNull()
    expect(catalogStockFilterClause(undefined)).toBeNull()
    expect(catalogStockFilterClause('x; DROP TABLE products' as never)).toBeNull()
  })
})
