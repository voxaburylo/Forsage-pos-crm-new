import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { isDesktopChannelAllowed, isManagerSaleChannel } from '../src/security/desktopAuthorization'
import { WEB_MONEY_CHANNELS } from '../src/lan/webRpcChannels'

// 25.11.2026 (рішення власника): замовлення видає менеджер по замовленнях, клієнт оплачує на касі;
// неоплачене при видачі одразу стає боргом клієнта; видати можуть і менеджер, і касир.
describe('order hand-over with the unpaid rest on the customer debt', () => {
  let root = ''
  let db: LocalDatabase
  let orders: LocalOrderRepository
  let pos: LocalPosRepository
  let cashierId = ''
  let managerId = ''
  let shiftId = ''
  let customerId = ''

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-order-handover-'))
    db = new LocalDatabase(root)
    orders = new LocalOrderRepository(db)
    pos = new LocalPosRepository(db)
    cashierId = randomUUID(); managerId = randomUUID(); shiftId = randomUUID(); customerId = randomUUID()
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO shifts (id, tenant_id, cashier_id, status, opening_cash, opened_at, created_at, updated_at)
      VALUES (?, ?, ?, 'open', 0, ?, ?, ?)`).run(shiftId, DEFAULT_TENANT_ID, cashierId, now, now, now)
    db.prepare(`INSERT INTO customers (id, tenant_id, phone, full_name, debt_balance, created_at, updated_at)
      VALUES (?, ?, '0670000000', 'СТО Тест', 5000, ?, ?)`).run(customerId, DEFAULT_TENANT_ID, now, now)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-order-handover-')) rmSync(root, { recursive: true, force: true })
  })

  function product(qty = 10) {
    const id = randomUUID(), now = new Date().toISOString()
    db.prepare(`INSERT INTO products (id, tenant_id, sku, name, purchase_price, retail_price, qty_on_hand, created_at, updated_at)
      VALUES (?, ?, ?, 'Фільтр', 200, 1000, ?, ?, ?)`).run(id, DEFAULT_TENANT_ID, 'F-' + id.slice(0, 6), qty, now, now)
    return id
  }

  function order(input: { paid: number; withCustomer?: boolean; status?: string }) {
    const productId = product()
    const saved = orders.saveOrder({
      tenant_id: DEFAULT_TENANT_ID, manager_id: managerId, customer_id: input.withCustomer === false ? null : customerId,
      items: [{ id: randomUUID(), name: 'Фільтр', sku: 'F-1', product_id: productId, buy_price: 200, sell_price: 1000, qty: 3, item_status: input.status ?? 'arrived' }],
    })
    if (input.paid > 0) orders.addPayment(saved.id, { tenant_id: DEFAULT_TENANT_ID, user_id: cashierId, shift_id: shiftId, amount: input.paid, method: 'cash' })
    return { orderId: saved.id as string, productId }
  }

  const debt = () => (db.prepare('SELECT debt_balance FROM customers WHERE id = ?').get(customerId) as { debt_balance: number }).debt_balance

  it('a manager without a shift hands over a partly prepaid order: prepayment counts, the rest becomes debt, stock leaves', () => {
    const { orderId, productId } = order({ paid: 1000 })
    const result = orders.completeOrder(orderId, { user_id: managerId, on_debt: true })
    expect(result.data.debt_amount).toBe(2000)
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(result.data.sale_id) as any
    expect(sale).toMatchObject({ shift_id: shiftId, cashier_id: managerId, total: 3000, cash_amount: 1000, debt_amount: 2000, is_debt: 1, payment_method: 'mixed', customer_id: customerId })
    expect(debt()).toBe(5000 + 2000)
    expect(db.prepare('SELECT qty_on_hand FROM products WHERE id = ?').get(productId)).toEqual({ qty_on_hand: 7 })
    expect(db.prepare('SELECT status, sale_id FROM customer_orders WHERE id = ?').get(orderId)).toEqual({ status: 'completed', sale_id: result.data.sale_id })
    const outbox = db.prepare("SELECT payload_json FROM sync_outbox WHERE operation_type = 'order.completed' AND aggregate_id = ?").get(orderId) as { payload_json: string }
    const payload = JSON.parse(outbox.payload_json)
    expect(payload).toMatchObject({ debt_amount: 2000, is_debt: true, sale: { debt_amount: 2000, is_debt: true } })
    // Повтор того самого запиту не створює другий чек і не подвоює борг.
    expect(orders.completeOrder(orderId, { user_id: managerId, on_debt: true }).data.sale_id).toBe(result.data.sale_id)
    expect(debt()).toBe(7000)
  })

  it('nothing prepaid: the whole order is debt and the receipt says so', () => {
    const { orderId } = order({ paid: 0 })
    const result = orders.completeOrder(orderId, { user_id: cashierId, on_debt: true })
    const sale = db.prepare('SELECT payment_method, debt_amount, cash_amount, notes FROM sales WHERE id = ?').get(result.data.sale_id) as any
    expect(sale).toMatchObject({ payment_method: 'debt', debt_amount: 3000, cash_amount: 0 })
    expect(sale.notes).toContain('у борг 30.00 грн')
    expect(debt()).toBe(8000)
  })

  it('the shift shows the order debt once and no received money for it', () => {
    const { orderId } = order({ paid: 1000 })
    orders.completeOrder(orderId, { user_id: managerId, on_debt: true })
    const report = pos.getShiftReport(cashierId)!
    expect(report.by_method.debt).toBe(2000)
    expect(report.by_method.cash).toBe(1000) // лише передоплата, прийнята раніше
    expect(report.payment_received_total).toBe(1000)
  })

  it('a fully paid order handed over by the manager has no debt', () => {
    const { orderId } = order({ paid: 3000 })
    const result = orders.completeOrder(orderId, { user_id: managerId, on_debt: true })
    expect(result.data.debt_amount).toBe(0)
    expect(db.prepare('SELECT is_debt, debt_amount FROM sales WHERE id = ?').get(result.data.sale_id)).toEqual({ is_debt: 0, debt_amount: 0 })
    expect(debt()).toBe(5000)
  })

  it('refuses: unpaid without a customer, items not arrived, ordinary completion without payment, no open shift', () => {
    expect(() => orders.completeOrder(order({ paid: 0, withCustomer: false }).orderId, { user_id: managerId, on_debt: true })).toThrow(/лише клієнту/)
    expect(() => orders.completeOrder(order({ paid: 0, status: 'ordered' }).orderId, { user_id: managerId, on_debt: true })).toThrow(/отримані/)
    expect(() => orders.completeOrder(order({ paid: 1000 }).orderId, { user_id: cashierId, shift_id: shiftId })).toThrow(/Не всі оплати/)
    const pending = order({ paid: 0 }).orderId
    db.prepare("UPDATE shifts SET status = 'closed' WHERE id = ?").run(shiftId)
    expect(() => orders.completeOrder(pending, { user_id: managerId, on_debt: true })).toThrow(/зміна не відкрита/)
    expect(debt()).toBe(5000)
  })

  function twoLineOrder(paid: number, secondStatus = 'ordered') {
    const first = product(), second = product()
    const firstItem = randomUUID(), secondItem = randomUUID()
    const saved = orders.saveOrder({
      tenant_id: DEFAULT_TENANT_ID, manager_id: managerId, customer_id: customerId, comment: 'Ремонт ходової',
      items: [
        { id: firstItem, name: 'Фільтр', sku: 'F-1', product_id: first, buy_price: 200, sell_price: 1000, qty: 1, item_status: 'arrived' },
        { id: secondItem, name: 'Колодки', sku: 'K-1', product_id: second, buy_price: 500, sell_price: 2000, qty: 1, item_status: secondStatus },
      ],
    })
    if (paid > 0) orders.addPayment(saved.id, { tenant_id: DEFAULT_TENANT_ID, user_id: cashierId, shift_id: shiftId, amount: paid, method: 'cash' })
    return { orderId: saved.id as string, firstItem, secondItem, first, second }
  }
  const deposit = () => (db.prepare('SELECT deposit_balance FROM customers WHERE id = ?').get(customerId) as { deposit_balance: number }).deposit_balance

  it('partial hand-over: arrived lines leave with their own receipt, the rest moves to a new order with the same lines', () => {
    const { orderId, firstItem, secondItem, first, second } = twoLineOrder(500)
    const result = orders.handOverItems(orderId, { user_id: managerId, item_ids: [firstItem] })
    expect(result.data).toMatchObject({ debt_amount: 500, moved_to_account: 0 })
    const restId = result.data.rest_order_id!
    expect(db.prepare('SELECT order_id, item_status FROM customer_order_items WHERE id = ?').get(secondItem)).toEqual({ order_id: restId, item_status: 'ordered' })
    expect(db.prepare('SELECT order_id, item_status FROM customer_order_items WHERE id = ?').get(firstItem)).toEqual({ order_id: orderId, item_status: 'handed' })
    expect(db.prepare('SELECT status, total_amount, total_paid FROM customer_orders WHERE id = ?').get(orderId)).toEqual({ status: 'completed', total_amount: 1000, total_paid: 500 })
    const restOrder = db.prepare('SELECT status, total_amount, total_paid, customer_id, manager_id, comment, order_number FROM customer_orders WHERE id = ?').get(restId) as any
    expect(restOrder).toMatchObject({ status: 'ordered', total_amount: 2000, total_paid: 0, customer_id: customerId, manager_id: managerId })
    expect(restOrder.comment).toContain('Ремонт ходової')
    expect(restOrder.order_number).toBe(result.data.rest_order_number)
    expect(db.prepare('SELECT total, debt_amount FROM sales WHERE id = ?').get(result.data.sale_id)).toEqual({ total: 1000, debt_amount: 500 })
    expect(db.prepare('SELECT qty_on_hand FROM products WHERE id = ?').get(first)).toEqual({ qty_on_hand: 9 })
    expect(db.prepare('SELECT qty_on_hand FROM products WHERE id = ?').get(second)).toEqual({ qty_on_hand: 10 })
    expect(debt()).toBe(5500)
    // Сервер отримує спершу старе замовлення (без перенесеної позиції), потім нове, потім видачу.
    const ops = db.prepare("SELECT operation_type, aggregate_id FROM sync_outbox WHERE operation_type IN ('order.updated','order.created','order.completed','customer.deposit_changed') ORDER BY rowid").all() as any[]
    const tail = ops.slice(-3).map(op => op.operation_type + ':' + (op.aggregate_id === orderId ? 'old' : op.aggregate_id === restId ? 'new' : 'other'))
    expect(tail).toEqual(['order.updated:old', 'order.created:new', 'order.completed:old'])
  })

  it('prepaid more than the handed lines: the surplus goes to the customer account, the shift money stays the same', () => {
    const { orderId, firstItem } = twoLineOrder(3000)
    const before = pos.getShiftReport(cashierId)!
    const result = orders.handOverItems(orderId, { user_id: cashierId, item_ids: [firstItem] })
    expect(result.data).toMatchObject({ debt_amount: 0, moved_to_account: 2000 })
    expect(deposit()).toBe(2000)
    expect(debt()).toBe(5000)
    expect(db.prepare('SELECT total, cash_amount, debt_amount FROM sales WHERE id = ?').get(result.data.sale_id)).toEqual({ total: 1000, cash_amount: 1000, debt_amount: 0 })
    const after = pos.getShiftReport(cashierId)!
    expect(after.by_method).toEqual(before.by_method)
    expect(after.payment_received_total).toBe(before.payment_received_total)
  })

  it('handing over every open line is an ordinary hand-over; not-arrived lines and discounted orders are refused', () => {
    const all = twoLineOrder(0, 'arrived')
    const whole = orders.handOverItems(all.orderId, { user_id: managerId, item_ids: [all.firstItem, all.secondItem] })
    expect(whole.data.rest_order_id).toBeUndefined()
    expect(whole.data.debt_amount).toBe(3000)
    const pending = twoLineOrder(0)
    expect(() => orders.handOverItems(pending.orderId, { user_id: managerId, item_ids: [pending.secondItem] })).toThrow(/лише прибулі/)
    expect(() => orders.handOverItems(pending.orderId, { user_id: managerId, item_ids: [] })).toThrow(/Виберіть позиції/)
    db.prepare('UPDATE customer_orders SET discount_amount = 100 WHERE id = ?').run(pending.orderId)
    expect(() => orders.handOverItems(pending.orderId, { user_id: managerId, item_ids: [pending.firstItem] })).toThrow(/знижку/)
    expect(db.prepare('SELECT COUNT(*) n FROM customer_order_items WHERE order_id = ?').get(pending.orderId)).toEqual({ n: 2 })
  })

  it('the manager may hand over without the sale permission; the web may not', () => {
    expect(isDesktopChannelAllowed('desktop:orders:hand-over', 'manager')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:orders:hand-over', 'cashier')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:orders:hand-over', 'storekeeper')).toBe(false)
    expect(isManagerSaleChannel('desktop:orders:hand-over')).toBe(false)
    expect(WEB_MONEY_CHANNELS).toContain('desktop:orders:hand-over')
  })
})
