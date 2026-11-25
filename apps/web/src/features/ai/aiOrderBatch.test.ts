import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { batchOf, forgetBatchOrders, readBatchOrders, rememberBatchOrder } from './aiOrderBatch'

function memory() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
}

// 24.11.2026 (план C2): одна загрузка фото блокнота — одна пачка.
describe('notebook batch memory', () => {
  it('remembers orders of one upload and only the customers that upload created', () => {
    const storage = memory()
    rememberBatchOrder('chat', storage, 'a1', { id: 'o-1', order_number: 41, customer_id: 'c-1', customer_created: true })
    rememberBatchOrder('chat', storage, 'a2', { id: 'o-2', order_number: 42, customer_id: 'c-2', customer_created: false })
    rememberBatchOrder('chat', storage, 'b1', { id: 'o-3', order_number: 43, customer_id: 'c-3', customer_created: true })
    rememberBatchOrder('chat', storage, 'bad', { id: "x' OR 1" })
    const store = readBatchOrders('chat', storage)
    expect(Object.keys(store)).toEqual(['a1', 'a2', 'b1'])
    expect(batchOf(['a1', 'a2', 'not-applied'], store)).toEqual({ actionIds: ['a1', 'a2'], order_ids: ['o-1', 'o-2'], customer_ids: ['c-1'], numbers: [41, 42] })
    forgetBatchOrders('chat', storage, ['a1', 'a2'])
    expect(Object.keys(readBatchOrders('chat', storage))).toEqual(['b1'])
  })

  it('a damaged memory gives no batch instead of a wrong one', () => {
    const storage = memory()
    storage.setItem('chat:order-batch', 'not json')
    expect(readBatchOrders('chat', storage)).toEqual({})
    storage.setItem('chat:order-batch', JSON.stringify({ a: { order_id: 5 }, b: { order_id: 'o-1', customer_id: 'x y', customer_created: 'yes' } }))
    expect(readBatchOrders('chat', storage)).toEqual({ b: { order_id: 'o-1', order_number: null, customer_id: null, customer_created: false } })
  })

  it('the order form takes several screenshots and appends their items to the same order', () => {
    const form = readFileSync(new URL('../orders/OrderFormPage.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(form).toContain('<input type="file" accept="image/*" multiple className="hidden" disabled={cartBusy}')
    expect(form).toContain("...current.filter((row) => row.name.trim() || row.sku.trim()),\n          ...placed.map(") // 25.11.2026: спершу розкладено по місцях (склад/постачальник)
    expect(form).toContain('void addCartScreenshotRef.current(files)')
  })
})
