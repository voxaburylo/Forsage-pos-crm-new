import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalOrderRepository } from '../src/repositories/orderRepository'

/** 22.11.2026: замовлення з блокнота одразу отримує стан із зошита — без грошей і без руху складу. */
describe('notebook order initial status', () => {
  let root: string, db: LocalDatabase, orders: LocalOrderRepository
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-notebook-')); db = new LocalDatabase(root); orders = new LocalOrderRepository(db) })
  afterEach(() => { db.close(); if (path.basename(root).startsWith('forsage-notebook-')) rmSync(root, { recursive: true, force: true }) })
  const input = (extra: Record<string, unknown> = {}) => ({
    items: [{ name: 'Опора шарова', sku: 'CB0269', qty: 2, sell_price: 54500, source_type: 'supplier', item_status: 'pending' }], ...extra,
  })
  const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

  it.each(['ordered', 'arrived', 'called', 'archived'])('creates an order already in state %s without money or stock movement', status => {
    const order = orders.saveOrder(input({ initial_status: status, operation_id: 'notebook-operation-' + status }))
    expect(order.status).toBe(status)
    expect(order.total_amount).toBe(109000)
    expect(order.total_paid).toBe(0)
    expect(order.prepayment).toBe(0)
    for (const table of ['sales', 'cash_operations', 'stock_reserves', 'inventory_movements']) expect(count(table)).toBe(0)
  })

  it('is idempotent: the same photo confirmed twice gives the same order', () => {
    const first = orders.saveOrder(input({ initial_status: 'ordered', operation_id: 'notebook-operation-0001' }))
    const again = orders.saveOrder(input({ initial_status: 'ordered', operation_id: 'notebook-operation-0001' }))
    expect(again.id).toBe(first.id)
    expect(count('customer_orders')).toBe(1)
  })

  it('refuses unknown states, money states, and changing the state through an edit', () => {
    for (const status of ['completed', 'canceled', 'ready', 'paid', '']) expect(() => orders.saveOrder(input({ initial_status: status }))).toThrow('Некоректний початковий стан')
    const order = orders.saveOrder(input())
    expect(order.status).toBe('lead')
    expect(() => orders.saveOrder(input({ initial_status: 'archived' }), order.id)).toThrow('лише при створенні')
  })

  it('keeps an archived notebook order closed for edits and payments', () => {
    const order = orders.saveOrder(input({ initial_status: 'archived' }))
    expect(() => orders.saveOrder(input(), order.id)).toThrow()
    expect(() => orders.updateOrderStatus(order.id, 'ordered')).toThrow()
  })

  it('does not create the same notebook order twice when the page is photographed again', () => {
    const first = orders.saveOrder(input({ initial_status: 'ordered', comment: 'Fiat Doblo', operation_id: 'notebook-operation-000a' }))
    expect(() => orders.saveOrder(input({ initial_status: 'ordered', comment: 'Fiat Doblo', operation_id: 'notebook-operation-000b' }))).toThrow('вже є в програмі (№ ' + first.order_number + ')')
    expect(count('customer_orders')).toBe(1)
    // Another client's order with other parts or another price is a different order.
    orders.saveOrder({ initial_status: 'ordered', comment: 'Fiat Doblo', items: [{ name: 'Опора шарова', sku: 'CB0269', qty: 2, sell_price: 60000, source_type: 'supplier', item_status: 'pending' }] })
    orders.saveOrder(input({ initial_status: 'ordered', comment: 'Kia Cerato' }))
    expect(count('customer_orders')).toBe(3)
    // An ordinary order typed by hand is never blocked by this check.
    orders.saveOrder(input({ comment: 'Fiat Doblo' }))
    expect(count('customer_orders')).toBe(4)
  })

  it('lets a mistaken notebook import be deleted while there was no money or handover, and only then', () => {
    for (const status of ['ordered', 'arrived', 'called', 'archived']) {
      const imported = orders.saveOrder(input({ initial_status: status, comment: 'Помилка ' + status }))
      expect(imported.from_notebook).toBe(true)
      expect(orders.deleteOrder(imported.id)).toEqual({ success: true })
      expect(orders.getOrder(imported.id)).toBeNull()
    }
    const deleted = db.prepare("SELECT payload_json FROM sync_outbox WHERE operation_type = 'order.deleted' ORDER BY rowid DESC LIMIT 1").get() as { payload_json: string }
    expect(JSON.parse(deleted.payload_json).from_notebook).toBe(true)
    // An ordinary order that the manager moved to «замовлено» keeps the old rule.
    const ordinary = orders.saveOrder(input({ comment: 'Звичайне' }))
    expect(ordinary.from_notebook).toBe(false)
    orders.updateOrderStatus(ordinary.id, 'ordered')
    expect(() => orders.deleteOrder(ordinary.id)).toThrow('Видалити можна лише')
    // A notebook order with a handed-over line is real history and stays.
    const handed = orders.saveOrder(input({ initial_status: 'ordered', comment: 'Видане' }))
    db.prepare("UPDATE customer_order_items SET item_status = 'handed' WHERE order_id = ?").run(handed.id)
    expect(() => orders.deleteOrder(handed.id)).toThrow('Видалити можна лише')
  })
})
