import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CustomerOrder } from '@/features/orders/orderApi'
import { checkTillOrderAppend, tillOrderAppendToUpdate } from './tillOrderAppendModel'

const ORDER = '11111111-2222-4333-8444-555555555555', CARD = '99999999-2222-4333-8444-555555555555', OP = '77777777-2222-4333-8444-555555555555'
const existing = { id: 'item-1', order_id: ORDER, name: 'Колодки передні', sku: 'GDB1330', product_id: null, supplier_id: 'sup-1', source_type: 'supplier', item_type: 'product',
  item_status: 'ordered', buy_price: 90000, sell_price: 125000, qty: 1, expected_date: '2026-11-25', core_deposit_amount: 5000, core_return_status: 'pending' }
const order = (over: Record<string, unknown> = {}) => ({ id: ORDER, status: 'ordered', sale_id: null, updated_at: '2026-11-22T06:00:00.000Z', comment: 'Дзвонити після 17',
  prepayment: 30000, total_paid: 30000, customer_id: 'cust-1', items: [existing], ...over }) as unknown as CustomerOrder
const append = (over: Record<string, unknown> = {}) => ({ order_id: ORDER, author: 'Олена', comment: 'клієнт дозамовив', items: [{ name: 'Фільтр', sku: 'W712', qty: 2, sell_price: 30000, buy_price: 20000 }], ...over })

describe('adding items to an existing order from the web (stage 8, 22.11.2026)', () => {
  it('keeps every existing row untouched and adds the new ones at the end', () => {
    const update = tillOrderAppendToUpdate(append(), order(), OP)
    expect(update.operation_id).toBe(OP)
    expect(update.expected_updated_at).toBe('2026-11-22T06:00:00.000Z')
    expect(update.items).toEqual([existing, { name: 'Фільтр', sku: 'W712', qty: 2, sell_price: 30000, buy_price: 20000, source_type: 'supplier' }])
    expect(update.comment).toBe('Дзвонити після 17\nДозамовлено у вебі (Олена): позицій 1. клієнт дозамовив')
    // Клієнт, авто, гроші й стан не передаються — каса лишає їх як є.
    for (const key of ['customer_id', 'vehicle_info', 'prepayment', 'prepayment_method', 'initial_status', 'source']) expect(update).not.toHaveProperty(key)
  })
  it('takes a stock item from the till card and never below its purchase price', () => {
    const cards = new Map([[CARD, { id: CARD, name: 'Фільтр масляний W712', sku: 'W712', retail_price: 30000, purchase_price: 21000 }]])
    const update = tillOrderAppendToUpdate(append({ items: [{ name: 'з вебу', qty: 1, sell_price: 0, product_id: CARD }] }), order(), OP, cards)
    expect(update.items.at(-1)).toEqual({ name: 'Фільтр масляний W712', sku: 'W712', product_id: CARD, qty: 1, sell_price: 30000, buy_price: 21000, source_type: 'warehouse' })
    expect(() => tillOrderAppendToUpdate(append({ items: [{ name: 'x', qty: 1, sell_price: 20000, product_id: CARD }] }), order(), OP, cards)).toThrow('нижча за закупівельну')
    expect(() => tillOrderAppendToUpdate(append({ items: [{ name: 'x', qty: 1, sell_price: 0, product_id: CARD }] }), order(), OP, new Map())).toThrow('немає в базі каси')
  })
  it('refuses a closed order, an order with handed items and an order the till does not have', () => {
    for (const status of ['completed', 'canceled', 'archived']) expect(() => tillOrderAppendToUpdate(append(), order({ status }), OP)).toThrow('вже закрите')
    expect(() => tillOrderAppendToUpdate(append(), order({ sale_id: 'sale-1' }), OP)).toThrow('вже закрите')
    expect(() => tillOrderAppendToUpdate(append(), order({ items: [{ ...existing, item_status: 'handed' }] }), OP)).toThrow('лише на касі')
    expect(() => tillOrderAppendToUpdate(append(), null, OP)).toThrow('немає в базі каси')
    expect(() => tillOrderAppendToUpdate(append(), order({ id: 'other' }), OP)).toThrow('немає в базі каси')
  })
  it('checks the request itself: order id, at least one item, price not below purchase, no extra fields', () => {
    expect(() => checkTillOrderAppend(append({ order_id: 'nope' }))).toThrow('Не вказано замовлення')
    expect(() => checkTillOrderAppend(append({ items: [] }))).toThrow('хоча б одну')
    expect(() => checkTillOrderAppend(append({ items: [{ name: 'x', qty: 1, sell_price: 100, buy_price: 200 }] }))).toThrow('нижча за закупку')
    const checked = checkTillOrderAppend(append({ prepayment: 5000, status: 'completed' }))
    expect(Object.keys(checked).sort()).toEqual(['author', 'comment', 'items', 'order_id'])
  })
  it('the web screens only send order.append; they never write orders or money themselves', () => {
    for (const file of ['../orders/WebOrderFormPage.tsx', '../orders/WebOrderAppendPage.tsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      for (const banned of ['orderApi', 'customerApi', 'prepayment', 'api.put', 'api.delete']) expect(source, file).not.toContain(banned)
    }
    const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
    const route = app.split('\n').filter(line => line.includes('<Route path="/orders/:id/add"'))
    expect(route).toHaveLength(1)
    // 23.11.2026: з головним ПК на зв'язку — повна картка через ПК; без нього — цей екран (лише order.append).
    expect(route[0]).toContain('<MainPcWhenOnline view={<WebOrderAppendPage />}><OrderDetailPage /></MainPcWhenOnline>')
  })
})
