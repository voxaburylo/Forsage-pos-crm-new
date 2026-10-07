import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalOrderRepository } from '../src/repositories/orderRepository'

describe('readiness: money stored in whole kopecks', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository
  let cashier: string, shift: string, product: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-readiness-money-'))
    db = new LocalDatabase(root); pos = new LocalPosRepository(db)
    cashier = randomUUID(); shift = pos.openShift({ cashier_id: cashier, opening_cash: 1000 })
    product = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: randomUUID(), name: 'Тест', qty_on_hand: 5, retail_price: 100 }).id
  })
  afterEach(() => {
    db.close()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-readiness-money-')) rmSync(root, { recursive: true, force: true })
  })
  it.each([
    [{ method: 'cash' as const, amount: 100.4 }],
    [{ method: 'cash' as const, amount: 49.6 }, { method: 'card' as const, amount: 49.6 }],
  ])('does not silently accept sub-kopeck payments %j', (...payments) => {
    expect(() => pos.checkout({
      cashier_id: cashier, shift_id: shift,
      items: [{ product_id: product, qty: 1, unit_price: 100 }], payments,
    })).toThrow()
    expect(db.prepare('SELECT COUNT(*) n FROM sales').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) n FROM sale_payments').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT qty_on_hand qty FROM products WHERE id=?').get(product)).toEqual({ qty: 5 })
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(1000)
  })
  it('keeps rounded order money unchanged when the item becomes ready and is paid', () => {
    const orders = new LocalOrderRepository(db)
    const order = orders.saveOrder({ manager_id: cashier, items: [{
      product_id: product, name: 'Дробова позиція', qty: 0.3, buy_price: 60, sell_price: 101, item_status: 'pending',
    }] })
    expect(order.total_amount).toBe(30)
    orders.updateOrderItemStatus(order.id, order.items[0].id, 'ordered')
    expect(orders.getOrder(order.id).total_amount).toBe(30)
    orders.updateOrderItemStatus(order.id, order.items[0].id, 'arrived')
    expect(orders.getOrder(order.id).total_amount).toBe(30)
    orders.addPayment(order.id, { payment_id: randomUUID(), user_id: cashier, shift_id: shift, amount: 30, method: 'cash' })
    const issued = orders.completeOrder(order.id, { user_id: cashier, shift_id: shift })
    expect(pos.getSale(issued.data.sale_id).total).toBe(30)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(1030)
  })
  it('allocates a one-kopeck discount and returns the exact full amount across restart', () => {
    const receipt = pos.checkout({
      cashier_id: cashier, shift_id: shift, discount: 1,
      items: [{ product_id: product, qty: 3, unit_price: 100 }], payments: [{ method: 'cash', amount: 299 }],
    })
    const line = pos.getSaleForReturn(receipt.sale_id).items[0]
    const refund = () => pos.createReturn({
      sale_id: receipt.sale_id, approved_by: cashier, shift_id: shift, client_operation_id: randomUUID(),
      items: [{ sale_item_id: line.id, product_id: product, quantity: 1 }],
    }).refund_kopecks
    expect(refund()).toBe(100)
    db.close(); db = new LocalDatabase(root); pos = new LocalPosRepository(db)
    expect(refund()).toBe(100)
    expect(refund()).toBe(99)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(1000)
    expect(db.prepare('SELECT qty_on_hand qty FROM products WHERE id=?').get(product)).toEqual({ qty: 5 })
    expect(pos.getSale(receipt.sale_id).status).toBe('returned')
  })
})
