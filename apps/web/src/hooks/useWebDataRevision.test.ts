import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { freshnessAdvanced } from './useWebDataRevision'

it('signals new till data only when the timestamp moves forward', () => {
  expect(freshnessAdvanced(undefined, '2026-11-21T10:00:00Z')).toBe(false)
  expect(freshnessAdvanced('2026-11-21T10:00:00Z', '2026-11-21T10:00:00Z')).toBe(false)
  expect(freshnessAdvanced('2026-11-21T10:00:00Z', '2026-11-21T10:01:00Z')).toBe(true)
  expect(freshnessAdvanced(null, '2026-11-21T10:01:00Z')).toBe(true)
  expect(freshnessAdvanced('2026-11-21T10:01:00Z', null)).toBe(false)
})

// 23.11.2026 (план C1): товари й замовлення теж перечитують першу сторінку, коли каса надіслала нові дані.
describe('lists that refresh by themselves', () => {
  it('goods and orders listen for new till data and reload only their first page', () => {
    const products = readFileSync(new URL('../features/products/ProductsPage.tsx', import.meta.url), 'utf8')
    expect(products).toContain('if (dataRevision > 0 && productsPageRef.current === 1) void productsLoadRef.current()')
    const orders = readFileSync(new URL('../features/orders/OrdersPage.tsx', import.meta.url), 'utf8')
    expect(orders).toContain('if (dataRevision > 0 && ordersOffsetRef.current === 0) void ordersLoadRef.current(false)')
  })
})
