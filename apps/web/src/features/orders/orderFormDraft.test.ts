import { describe, expect, it } from 'vitest'
import { readOrderFormDraft, writeOrderFormDraft } from './orderFormDraft'

describe('device-local order form backup', () => {
  const data = { items: [{ name: 'Фільтр', sku: 'W67/1', qty: '2', sell_price: '200', supplier_id: '' }], loadedOrderVersion: 'version-before-edit', customerId: 'customer-1' }
  it('restores all rows and the original concurrency token', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    expect(writeOrderFormDraft('user-1:order-1', data, storage)).toBe(true)
    expect(readOrderFormDraft('user-1:order-1', storage)).toEqual(data)
    expect(readOrderFormDraft('user-2:order-1', storage)).toBeNull()
    expect(readOrderFormDraft('user-1:order-2', storage)).toBeNull()
  })
  it.each(['broken', '{}', '{"version":2,"data":{"items":[]}}', '{"version":1,"data":{"items":[null]}}'])('ignores malformed/incompatible snapshots: %s', (raw) => {
    expect(readOrderFormDraft('key', { getItem: () => raw })).toBeNull()
  })
  it('reports unavailable storage without crashing the form', () => {
    expect(writeOrderFormDraft('key', data, { setItem: () => { throw new Error('quota') } })).toBe(false)
    expect(readOrderFormDraft('key', { getItem: () => { throw new Error('denied') } })).toBeNull()
  })
})
