import { expect, it } from 'vitest'
import { InvoicePriceGuard } from './invoicePriceGuard'
const row = (key = 'a') => ({ client_key: key, purchase_price: 1000, retail_price: 1200, category_id: null })
it('does not apply to a different row after deletion or reordering', () => {
  const guard = new InvoicePriceGuard(), a = row(), b = row('b'), request = guard.begin(a)
  expect(guard.apply([b], [{ request, retail: 1500 }])[0].retail_price).toBe(1200)
  expect(guard.apply([b, a], [{ request, retail: 1500 }]).map(r => r.retail_price)).toEqual([1200, 1500])
})
it('ignores a late answer when a newer calculation started', () => {
  const guard = new InvoicePriceGuard(), a = row(), old = guard.begin(a), latest = guard.begin(a)
  expect(guard.apply([a], [{ request: old, retail: 1800 }])).toEqual([a])
  expect(guard.apply([a], [{ request: latest, retail: 1500 }])[0].retail_price).toBe(1500)
})
it.each([{ purchase_price: 2000 }, { retail_price: 1300 }, { category_id: 'new' }])('keeps a newer manual edit %j', edit => {
  const guard = new InvoicePriceGuard(), a = row(), request = guard.begin(a), edited = { ...a, ...edit }
  expect(guard.apply([edited], [{ request, retail: 1500 }])).toEqual([edited])
})
it('manual intent invalidates even when the user chooses the same price', () => {
  const guard = new InvoicePriceGuard(), a = row(), request = guard.begin(a)
  guard.invalidate(a.client_key)
  expect(guard.apply([a], [{ request, retail: 1500 }])).toEqual([a])
})
it.each([NaN, Infinity, -1, 12.5])('rejects invalid calculated money %s', retail => {
  const guard = new InvoicePriceGuard(), a = row(), request = guard.begin(a)
  expect(guard.apply([a], [{ request, retail }])).toEqual([a])
})
