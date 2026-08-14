import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'

describe('local paid order cancellation', () => {
  let root = ''
  let db: LocalDatabase
  let orders: LocalOrderRepository
  let pos: LocalPosRepository
  let userId = ''
  let shiftId = ''

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-cancel-credit-'))
    db = new LocalDatabase(root)
    orders = new LocalOrderRepository(db)
    pos = new LocalPosRepository(db)
    userId = randomUUID()
    shiftId = randomUUID()
    const timestamp = new Date().toISOString()
    db.prepare(`
      INSERT INTO shifts (id, tenant_id, cashier_id, status, opening_cash, opened_at, created_at, updated_at)
      VALUES (?, ?, ?, 'open', 0, ?, ?, ?)
    `).run(shiftId, DEFAULT_TENANT_ID, userId, timestamp, timestamp, timestamp)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-cancel-credit-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('moves the payment to one customer balance exactly once', () => {
    const customer = pos.saveCustomer({ phone: '+380509999999', full_name: 'Canceled order customer' }).data
    const order = orders.saveOrder({
      customer_id: customer.id,
      manager_id: userId,
      items: [{ name: 'Замовна деталь', sku: 'ORDER-1', buy_price: 300, sell_price: 500, qty: 1 }],
    })
    orders.addPayment(order.id, {
      user_id: userId, amount: 500, method: 'card', shift_id: shiftId, is_fiscal: false,
    })

    orders.cancelOrder(order.id, { keep_as_credit: true, user_id: userId })
    orders.cancelOrder(order.id, { keep_as_credit: true, user_id: userId })

    expect(orders.getOrder(order.id)?.status).toBe('canceled')
    expect(pos.getCustomerDeposit(customer.id).balance).toBe(500)
    expect(db.prepare('SELECT amount, order_id FROM customer_deposit_transactions WHERE id = ?').get(order.id)).toEqual({
      amount: 500, order_id: order.id,
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM customer_deposit_transactions WHERE id = ?').get(order.id)).toEqual({ count: 1 })
  })
})
