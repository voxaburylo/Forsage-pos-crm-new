import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalOrderRepository } from '../src/repositories/orderRepository'

// 24.11.2026 (план C2, рішення власника): одна загрузка фото блокнота — одна пачка; скасувати її цілком або ніяк.
describe('cancel a whole notebook batch', () => {
  let root: string, db: LocalDatabase, orders: LocalOrderRepository
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-batch-'))
    db = new LocalDatabase(root); orders = new LocalOrderRepository(db)
  })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  const now = () => new Date().toISOString()
  const customer = (id: string) => db.prepare('INSERT INTO customers(id,tenant_id,full_name,phone,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, DEFAULT_TENANT_ID, 'Клієнт ' + id, '050' + id.length, now(), now())
  let serial = 0
  // Різний склад — інакше захист від дублів блокнота (той самий клієнт + склад) не дасть створити друге.
  const notebook = (customerId: string | null) => orders.saveOrder({
    customer_id: customerId, initial_status: 'ordered', comment: 'з блокнота ' + ++serial,
    items: [{ name: 'Колодки ' + serial, qty: 1, sell_price: 10000, source_type: 'supplier', item_status: 'ordered' }],
  })
  const alive = (orderId: string) => Boolean(db.prepare('SELECT 1 FROM customer_orders WHERE id = ? AND deleted_at IS NULL').get(orderId))
  const customerAlive = (id: string) => Boolean(db.prepare('SELECT 1 FROM customers WHERE id = ? AND deleted_at IS NULL').get(id))

  it('removes every order of the batch and the customers it created, when they have nothing else', () => {
    customer('c-new'); customer('c-old')
    const first = notebook('c-new'), second = notebook('c-old'), other = notebook('c-old')
    const result = orders.cancelNotebookBatch({ order_ids: [first.id, second.id], customer_ids: ['c-new', 'c-old'] })
    expect(result).toEqual({ orders: 2, customers: 1, kept_customers: 1 })
    expect([alive(first.id), alive(second.id), alive(other.id)]).toEqual([false, false, true])
    // c-old має ще одне замовлення — лишається.
    expect([customerAlive('c-new'), customerAlive('c-old')]).toEqual([false, true])
    const outbox = db.prepare("SELECT operation_type FROM sync_outbox WHERE operation_type IN ('order.deleted','customer.deleted') ORDER BY sequence").all() as Array<{ operation_type: string }>
    expect(outbox.map(row => row.operation_type)).toEqual(['order.deleted', 'order.deleted', 'customer.deleted'])
  })

  it('changes nothing when one order of the batch was paid, handed over or is not from the notebook', () => {
    customer('c-1')
    const good = notebook('c-1'), handed = notebook('c-1')
    db.prepare("UPDATE customer_order_items SET item_status = 'handed' WHERE order_id = ?").run(handed.id)
    expect(() => orders.cancelNotebookBatch({ order_ids: [good.id, handed.id], customer_ids: ['c-1'] })).toThrow(/Пачку не скасовано/)
    expect([alive(good.id), alive(handed.id), customerAlive('c-1')]).toEqual([true, true, true])
    const manual = orders.saveOrder({ customer_id: null, comment: 'вручну', items: [{ name: 'Фільтр', qty: 1, sell_price: 5000, source_type: 'supplier' }] })
    expect(() => orders.cancelNotebookBatch({ order_ids: [good.id, manual.id] })).toThrow(/не з блокнота/)
    expect([alive(good.id), alive(manual.id)]).toEqual([true, true])
  })

  it('refuses empty, oversized or malformed lists and a missing order', () => {
    expect(() => orders.cancelNotebookBatch({ order_ids: [] })).toThrow('У пачці немає замовлень')
    expect(() => orders.cancelNotebookBatch({ order_ids: 'x' })).toThrow('Некоректний перелік')
    expect(() => orders.cancelNotebookBatch({ order_ids: ["a' OR 1=1"] })).toThrow('Некоректний перелік')
    expect(() => orders.cancelNotebookBatch({ order_ids: Array.from({ length: 101 }, (_, i) => 'o' + i) })).toThrow('Некоректний перелік')
    expect(() => orders.cancelNotebookBatch({ order_ids: ['missing'] })).toThrow(/не знайдено/)
  })
})
