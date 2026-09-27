import { afterEach, describe, expect, it, vi } from 'vitest'
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
  it.each(['broken', '{}', '{"version":2,"data":{"items":[]}}', '{"version":1,"data":{"items":[null]}}'])('does not silently overwrite malformed snapshots: %s', (raw) => {
    expect(() => readOrderFormDraft('key', { getItem: () => raw })).toThrow(/не перезаписано/)
  })
  it('reports unavailable storage without crashing the form', () => {
    expect(writeOrderFormDraft('key', data, { setItem: () => { throw new Error('quota') } })).toBe(false)
    expect(() => readOrderFormDraft('key', { getItem: () => { throw new Error('denied') } })).toThrow(/не перезаписано/)
  })
  afterEach(() => vi.unstubAllGlobals())
  it('migrates a legacy session once and survives an empty session after restart', () => {
    const durable = new Map<string,string>(), session = new Map([['key', JSON.stringify({ version:1, data })]])
    const store = (map: Map<string,string>) => ({ getItem:(key:string)=>map.get(key)??null, setItem:(key:string,value:string)=>map.set(key,value) })
    vi.stubGlobal('localStorage',store(durable)); vi.stubGlobal('sessionStorage',store(session))
    expect(readOrderFormDraft('key')).toEqual(data)
    session.clear()
    expect(readOrderFormDraft('key')).toEqual(data)
    expect(writeOrderFormDraft('key',{ ...data, comment:'Нові правки' })).toBe(true)
    expect(readOrderFormDraft('key')).toEqual({ ...data, comment:'Нові правки' })
  })
})
