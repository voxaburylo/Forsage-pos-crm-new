import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'

// Рішення власника 20.11.2026: бонуси — гроші клієнта; ними можна оплатити 100% або внести передоплату.
// Бонуси й передоплата (рахунок клієнта) — окремі баланси.
describe('order prepayment with bonuses', () => {
  let root = ''
  let db: LocalDatabase
  let orders: LocalOrderRepository
  let pos: LocalPosRepository
  let cashier = ''
  let shift = ''
  let product = ''
  let customer = ''

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-order-bonus-'))
    db = new LocalDatabase(root)
    orders = new LocalOrderRepository(db)
    pos = new LocalPosRepository(db)
    cashier = randomUUID(); shift = randomUUID(); product = randomUUID()
    const at = new Date().toISOString()
    db.prepare("INSERT INTO shifts (id,tenant_id,cashier_id,status,opening_cash,opened_at,created_at,updated_at) VALUES (?,?,?,'open',0,?,?,?)")
      .run(shift, tenant, cashier, at, at, at)
    db.prepare('INSERT INTO products (id,tenant_id,sku,name,purchase_price,retail_price,qty_on_hand,created_at,updated_at) VALUES (?,?,?,?,30000,50000,5,?,?)')
      .run(product, tenant, 'BONUS-PART', 'Деталь під замовлення', at, at)
    customer = pos.saveCustomer({ phone: '+380501112233', full_name: 'Клієнт з бонусами' }).data.id
    db.prepare('UPDATE customers SET bonus_balance = 70000 WHERE id = ?').run(customer)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-order-bonus-')) rmSync(root, { recursive: true, force: true })
  })

  const order = () => orders.saveOrder({
    customer_id: customer, manager_id: cashier,
    items: [{ product_id: product, name: 'Деталь під замовлення', sku: 'BONUS-PART', buy_price: 30000, sell_price: 50000, qty: 1, item_status: 'arrived' }],
  })
  const bonus = () => (db.prepare('SELECT bonus_balance b FROM customers WHERE id = ?').get(customer) as { b: number }).b

  it('takes a bonus prepayment from the bonus balance, not from the till', () => {
    const created = order()
    orders.addPayment(created.id, { user_id: cashier, shift_id: shift, amount: 20000, method: 'bonus' })
    expect(bonus()).toBe(50000)
    expect(pos.getCustomerDeposit(customer).balance).toBe(0)
    expect(db.prepare("SELECT amount, transaction_type t FROM bonus_transactions WHERE customer_id = ?").all(customer)).toEqual([{ amount: -20000, t: 'spend' }])
    expect(db.prepare("SELECT COUNT(*) n FROM cash_operations WHERE shift_id = ?").get(shift)).toEqual({ n: 0 })
    expect(orders.getOrder(created.id)?.total_paid).toBe(20000)
    const outbox = db.prepare("SELECT payload_json FROM sync_outbox WHERE operation_type = 'order.payment_added'").get() as { payload_json: string }
    expect(JSON.parse(outbox.payload_json)).toMatchObject({ method: 'bonus', amount: 20000, bonus_balance_after: 50000 })
  })

  it('issues the order: bonuses are a discount on the receipt, money is only the rest', () => {
    const created = order()
    orders.addPayment(created.id, { user_id: cashier, shift_id: shift, amount: 20000, method: 'bonus' })
    orders.addPayment(created.id, { user_id: cashier, shift_id: shift, amount: 30000, method: 'cash' })
    const issued = orders.completeOrder(created.id, { user_id: cashier, shift_id: shift })
    expect(db.prepare('SELECT subtotal, discount, total, cash_amount FROM sales WHERE id = ?').get(issued.data.sale_id))
      .toEqual({ subtotal: 50000, discount: 20000, total: 30000, cash_amount: 30000 })
    const outbox = db.prepare("SELECT payload_json FROM sync_outbox WHERE operation_type = 'order.completed'").get() as { payload_json: string }
    expect(JSON.parse(outbox.payload_json)).toMatchObject({ bonuses_spent: 20000, cash_amount: 30000 })
  })

  it('may pay the whole order with bonuses', () => {
    const created = order()
    orders.addPayment(created.id, { user_id: cashier, shift_id: shift, amount: 50000, method: 'bonus' })
    const issued = orders.completeOrder(created.id, { user_id: cashier, shift_id: shift })
    expect(db.prepare('SELECT discount, total FROM sales WHERE id = ?').get(issued.data.sale_id)).toEqual({ discount: 50000, total: 0 })
    expect(bonus()).toBe(20000)
  })

  it('returns bonuses to bonuses and money to the account when the order is canceled', () => {
    const created = order()
    orders.addPayment(created.id, { user_id: cashier, shift_id: shift, amount: 20000, method: 'bonus' })
    orders.addPayment(created.id, { user_id: cashier, shift_id: shift, amount: 10000, method: 'card' })
    orders.cancelOrder(created.id, { keep_as_credit: true, user_id: cashier })
    orders.cancelOrder(created.id, { keep_as_credit: true, user_id: cashier })
    expect(bonus()).toBe(70000)
    expect(pos.getCustomerDeposit(customer).balance).toBe(10000)
    expect(db.prepare("SELECT amount FROM bonus_transactions WHERE customer_id = ? AND transaction_type = 'refund'").all(customer)).toEqual([{ amount: 20000 }])
    const outbox = db.prepare("SELECT payload_json FROM sync_outbox WHERE operation_type = 'order.canceled'").get() as { payload_json: string }
    expect(JSON.parse(outbox.payload_json)).toMatchObject({ credited_amount: 10000, bonus_refunded: 20000, bonus_balance: 70000 })
  })

  it('refuses more than the bonus balance and keeps the shift money report intact', () => {
    const created = order()
    expect(() => orders.addPayment(created.id, { user_id: cashier, shift_id: shift, amount: 50000, method: 'bonus' }))
      .not.toThrow()
    const second = order()
    expect(() => orders.addPayment(second.id, { user_id: cashier, shift_id: shift, amount: 30000, method: 'bonus' })).toThrow(/Недостатньо бонусів/)
    expect(bonus()).toBe(20000)
    // Бонуси не є грошима в касі: звіт зміни не падає і не показує їх як готівку.
    const report = pos.getShiftReport(cashier)
    expect(report.by_method).toMatchObject({ cash: 0, card: 0, transfer: 0, account: 0 })
    expect(report.payment_received_total).toBe(0)
  })
})
