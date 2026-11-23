import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalOrderRepository } from '../src/repositories/orderRepository'

/** 23.11.2026 (план C3): «Замовити в постачальника» — що з відкритих замовлень ще не замовлено. */
describe('supplier order lines on the till', () => {
  let root: string, db: LocalDatabase, orders: LocalOrderRepository
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-supplier-lines-'))
    db = new LocalDatabase(root); orders = new LocalOrderRepository(db)
    const now = new Date().toISOString()
    db.prepare('INSERT INTO suppliers(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('s-1', DEFAULT_TENANT_ID, 'Технікс', now, now)
    db.prepare('INSERT INTO customers(id,tenant_id,full_name,phone,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('c-1', DEFAULT_TENANT_ID, 'Іван', '0501112233', now, now)
  })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  const order = (items: Array<Record<string, unknown>>) => orders.saveOrder({
    customer_id: 'c-1', comment: 'тест',
    items: items.map(item => ({ qty: 1, sell_price: 10000, source_type: 'supplier', item_status: 'pending', ...item })),
  })

  it('lists only waiting supplier lines of open orders, with supplier and customer', () => {
    const open = order([{ name: 'Колодки', sku: 'GDB1550', supplier_id: 's-1', qty: 2 }, { name: 'Зі складу', source_type: 'warehouse' }, { name: 'Вже замовлено', item_status: 'ordered' }])
    const canceled = order([{ name: 'Скасоване' }])
    orders.cancelOrder(canceled.id, {})
    const lines = orders.listSupplierOrderLines()
    expect(lines.map(row => row.name)).toEqual(['Колодки'])
    expect(lines[0]).toMatchObject({ order_id: open.id, supplier_name: 'Технікс', customer_name: 'Іван', customer_phone: '0501112233', qty: 2 })
  })

  it('marks lines ordered together, skips lines another PC already moved, and rejects foreign ids', () => {
    const first = order([{ name: 'A' }, { name: 'B' }])
    const [a, b] = first.items
    orders.updateOrderItemStatus(first.id, b.id, 'ordered')
    expect(orders.bulkOrdered([a.id, b.id])).toEqual({ updated: 1 })
    expect(orders.getOrder(first.id).items.map((item: { item_status: string }) => item.item_status)).toEqual(['ordered', 'ordered'])
    expect(orders.getOrder(first.id).status).toBe('ordered')
    expect(orders.listSupplierOrderLines()).toEqual([])
    expect(() => orders.bulkOrdered(['missing'])).toThrow(/не знайдені/)
    expect(() => orders.bulkOrdered([])).toThrow()
  })
})
