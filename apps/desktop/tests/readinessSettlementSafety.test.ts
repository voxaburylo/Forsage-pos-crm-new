import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
import { LocalStaffRepository } from '../src/repositories/staffRepository'

describe('readiness: order and payroll settlements stay atomic and replay-safe', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository, orders: LocalOrderRepository, staff: LocalStaffRepository
  let shift: string, product: string, customer: string
  const workDate = '2026-09-26'
  function connect() {
    db = new LocalDatabase(root)
    pos = new LocalPosRepository(db); orders = new LocalOrderRepository(db); staff = new LocalStaffRepository(db)
  }
  function restart() { db.close(); connect() }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-28T10:00:00Z'))
    root = mkdtempSync(path.join(tmpdir(), 'forsage-readiness-settlement-')); connect()
    for (const [id, role] of [['cashier', 'cashier'], ['other', 'cashier'], ['worker', 'manager'], ['tire', 'tire_worker']]) {
      db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,is_active,base_rate,rate_period,created_at,updated_at) VALUES (?,?,?,?,1,0,?,?,?)')
        .run(id, tenant, id, role, 'day', new Date().toISOString(), new Date().toISOString())
    }
    shift = pos.openShift({ cashier_id: 'cashier', opening_cash: 1000 })
    product = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: 'SETTLEMENT-PART', name: 'Контрольний товар', qty_on_hand: 10, retail_price: 1000, purchase_price: 600 }).id
    customer = pos.saveCustomer({ full_name: 'Контрольний клієнт', phone: '0679998877' }).data.id
  })
  afterEach(() => {
    db.close(); vi.useRealTimers()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-readiness-settlement-')) rmSync(root, { recursive: true, force: true })
  })
  function snapshot() {
    return Object.fromEntries(['products', 'customer_orders', 'customer_order_items', 'order_payments', 'sales', 'sale_items',
      'cash_operations', 'shifts', 'inventory_movements', 'stock_reserves', 'salary_payments', 'customer_deposit_transactions', 'customers', 'sync_outbox', 'app_meta']
      .map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]))
  }
  function orderItem(overrides = {}) {
    return { product_id: product, name: 'Контрольний товар', qty: 2, buy_price: 600, sell_price: 1000, item_status: 'arrived', ...overrides }
  }
  function paidOrder() {
    const order = orders.saveOrder({ manager_id: 'worker', customer_id: customer, items: [orderItem()] })
    orders.addPayment(order.id, { payment_id: randomUUID(), user_id: 'cashier', shift_id: shift, amount: 2000, method: 'cash' })
    return order
  }
  function bonus(amount = 500) {
    return staff.createSalary({ employee_id: 'worker', amount, type: 'bonus', method: 'cash', work_date: workDate, user_id: 'cashier' })
  }
  function payout(overrides = {}) {
    return { operation_id: randomUUID(), employee_id: 'worker', method: 'cash' as const, fund_source: 'cashbox' as const,
      shift_id: shift, work_date: workDate, user_id: 'cashier', ...overrides }
  }
  // Synthetic late-day service; cash has not yet been handed over to the shop.
  function tireWork() {
    const timestamp = workDate + 'T16:30:00Z'
    const service = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: 'POS-TIRE-SERVICE', name: 'Шиномонтаж', is_service: true, retail_price: 36000 }).id
    db.prepare("INSERT INTO sales(id,tenant_id,sale_number,cashier_id,manager_id,shift_id,status,total,payment_method,cash_amount,completed_at,created_at,updated_at) VALUES ('tire-sale',?,'TIRE-TEST','cashier','tire',?,'completed',36000,'cash',36000,?,?,?)").run(tenant, shift, timestamp, timestamp, timestamp)
    db.prepare("INSERT INTO sale_items(id,tenant_id,sale_id,product_id,sku,description,qty,unit_price,purchase_price,total,created_at,updated_at) VALUES ('tire-line',?,'tire-sale',?,'POS-TIRE-SERVICE','Заміна коліс',1,36000,0,36000,?,?)").run(tenant, service, timestamp, timestamp)
    staff.createCommissionRule({ user_id: 'tire', rule_type: 'tire_service', pct_from_revenue: 35, pct_from_profit: 0 })
    staff.recordSaleCommissions('tire-sale', tenant, 'cashier')
  }
  function handover(overrides = {}) {
    return { operation_id: randomUUID(), employee_id: 'tire', work_date: workDate, shift_id: shift, amount: 1000, user_id: 'cashier', ...overrides }
  }

  it.each(['sell_price', 'buy_price', 'core_deposit_amount'])('rejects a fractional kopeck in order %s before saving', field => {
    const before = snapshot()
    expect(() => orders.saveOrder({ manager_id: 'worker', items: [orderItem({ [field]: 100.4 })] })).toThrow()
    expect(snapshot()).toEqual(before)
  })
  it('records order issue and its manager commission together, then replays exactly after restart', () => {
    staff.createCommissionRule({ user_id: 'worker', rule_type: 'order_sales', pct_from_revenue: 10, pct_from_profit: 0 })
    const order = paidOrder()
    const first = orders.completeOrder(order.id, { user_id: 'cashier', shift_id: shift })
    expect(staff.dailySummary('2026-09-28')).toMatchObject([{ employee_id: 'worker', earned: 200 }])
    const before = snapshot(); restart()
    expect(orders.completeOrder(order.id, { user_id: 'cashier', shift_id: shift })).toEqual(first)
    expect(snapshot()).toEqual(before)
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(3000)
  })
  it('rolls back the whole issue if the commission write fails, then retries safely', () => {
    staff.createCommissionRule({ user_id: 'worker', rule_type: 'order_sales', pct_from_revenue: 10, pct_from_profit: 0 })
    const order = paidOrder(), before = snapshot()
    db.exec("CREATE TRIGGER settlement_salary_failure BEFORE INSERT ON salary_payments BEGIN SELECT RAISE(ABORT, 'test salary failure'); END")
    expect(() => orders.completeOrder(order.id, { user_id: 'cashier', shift_id: shift })).toThrow('test salary failure')
    expect(snapshot()).toEqual(before)
    db.exec('DROP TRIGGER settlement_salary_failure')
    orders.completeOrder(order.id, { user_id: 'cashier', shift_id: shift })
    expect(staff.dailySummary('2026-09-28')[0].earned).toBe(200)
    expect(db.prepare('SELECT COUNT(*) n FROM sales').get()).toEqual({ n: 1 })
  })
  it('puts an order issued after Kyiv midnight into the same work day as its sale', () => {
    vi.setSystemTime(new Date('2026-09-27T21:30:00Z'))
    staff.createCommissionRule({ user_id: 'worker', rule_type: 'order_sales', pct_from_revenue: 10, pct_from_profit: 0 })
    const order = paidOrder()
    orders.completeOrder(order.id, { user_id: 'cashier', shift_id: shift })
    // Calling the compatibility entry point must not create a second accrual.
    staff.recordOrderCommissions(order.id, tenant, 'cashier')
    expect(staff.dailySummary('2026-09-28')[0]?.earned).toBe(200)
    expect(staff.dailySummary('2026-09-27')).toEqual([])
  })
  it('keeps mixed prepayments, customer-account credit and payout distinct across cancellation/restart', () => {
    pos.addCustomerDeposit({ operation_id: randomUUID(), customer_id: customer, amount: 600, method: 'card', user_id: 'cashier' })
    const order = orders.saveOrder({ manager_id: 'worker', customer_id: customer, items: [orderItem()] })
    const request = { payment_id: randomUUID(), user_id: 'cashier', shift_id: shift, amount: 500, method: 'cash' as const }
    orders.addPayment(order.id, request)
    orders.addPayment(order.id, { ...request, payment_id: randomUUID(), amount: 600, method: 'account' })
    orders.addPayment(order.id, { ...request, payment_id: randomUUID(), amount: 900, method: 'card' })
    restart(); orders.addPayment(order.id, request)
    expect(pos.getCustomerDeposit(customer).balance).toBe(0)
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(1500)
    orders.cancelOrder(order.id, { keep_as_credit: true, user_id: 'worker' })
    expect(pos.getCustomerDeposit(customer).balance).toBe(2000)
    const before = snapshot(); restart()
    orders.cancelOrder(order.id, { keep_as_credit: true, user_id: 'worker' })
    expect(snapshot()).toEqual(before)
    const refund = { payout_id: randomUUID(), customer_id: customer, amount: 500, method: 'cash' as const, shift_id: shift, user_id: 'cashier' }
    pos.payOutCustomerDeposit(refund); restart(); pos.payOutCustomerDeposit(refund)
    expect(pos.getCustomerDeposit(customer).balance).toBe(1500)
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(1000)
    expect(db.prepare('SELECT COUNT(*) n FROM sales').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT qty_on_hand qty FROM products WHERE id=?').get(product)).toEqual({ qty: 10 })
  })
  it('refuses an unpaid order remainder without moving stock or money', () => {
    const order = orders.saveOrder({ manager_id: 'worker', items: [orderItem()] })
    orders.addPayment(order.id, { user_id: 'cashier', shift_id: shift, amount: 1999, method: 'cash' })
    const before = snapshot()
    expect(() => orders.completeOrder(order.id, { user_id: 'cashier', shift_id: shift })).toThrow('Не всі оплати')
    expect(snapshot()).toEqual(before)
  })
  it('counts prepayment and final sale on their own days and never collects the advance twice', () => {
    const order = orders.saveOrder({ manager_id: 'worker', customer_id: customer, items: [orderItem()] })
    const advance = { payment_id: randomUUID(), user_id: 'cashier', shift_id: shift, amount: 500, method: 'cash' as const }
    orders.addPayment(order.id, advance)
    expect(pos.getShiftReport('cashier')).toMatchObject({ total_sales: 0, total_revenue: 0, payment_received_total: 500, by_method: { cash: 500, card: 0 } })
    pos.closeShift('cashier', 1500, null, shift)
    vi.setSystemTime(new Date('2026-09-29T10:00:00Z')); restart()
    shift = pos.openShift({ cashier_id: 'cashier', opening_cash: 0 })
    orders.addPayment(order.id, { payment_id: randomUUID(), user_id: 'cashier', shift_id: shift, amount: 1500, method: 'card' })
    const result = orders.completeOrder(order.id, { user_id: 'cashier', shift_id: shift })
    const before = snapshot(); restart()
    orders.addPayment(order.id, advance)
    expect(orders.completeOrder(order.id, { user_id: 'cashier', shift_id: shift })).toEqual(result)
    expect(snapshot()).toEqual(before)
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(0)
    expect(pos.getShiftReport('cashier')).toMatchObject({ total_sales: 1, total_revenue: 2000, payment_received_total: 1500, by_method: { cash: 0, card: 1500 } })
    const day1 = { date_from: '2026-09-28T00:00:00.000Z', date_to: '2026-09-28T23:59:59.999Z' }
    const day2 = { date_from: '2026-09-29T00:00:00.000Z', date_to: '2026-09-29T23:59:59.999Z' }
    expect(pos.dashboardSummary(day1).analytics.total_revenue).toBe(0)
    expect(pos.soldItemsReport(day1)).toEqual([])
    expect(pos.dashboardSummary(day2).analytics).toMatchObject({ total_revenue: 2000, cogs: 1200, gross_profit: 800 })
    expect(pos.soldItemsReport(day2)[0]).toMatchObject({ product_id: product, qty_sold: 2, revenue: 2000 })
  })
  it('keeps partial debt payments and a debt-reduction return consistent with cash and sold items', () => {
    const sale = pos.checkout({ client_operation_id: randomUUID(), cashier_id: 'cashier', shift_id: shift, customer_id: customer,
      items: [{ product_id: product, qty: 3, unit_price: 1000 }],
      payments: [{ method: 'cash', amount: 500 }, { method: 'card', amount: 500 }, { method: 'debt', amount: 2000 }],
    })
    const transfer = { operation_id: randomUUID(), customer_id: customer, amount: 600, method: 'transfer' as const, user_id: 'cashier', shift_id: shift }
    pos.payDebt(transfer)
    expect(pos.getCustomer(customer).debt_balance).toBe(1400)
    const line = pos.getSaleForReturn(sale.sale_id).items[0]
    const request = { client_operation_id: randomUUID(), sale_id: sale.sale_id, approved_by: 'cashier', shift_id: shift,
      refund_method: 'debt_reduction', stock_action: 'return_to_stock', items: [{ sale_item_id: line.id, product_id: product, quantity: 1 }] }
    const refund = pos.createReturn(request)
    expect(pos.getCustomer(customer).debt_balance).toBe(400)
    const cash = { ...transfer, operation_id: randomUUID(), amount: 400, method: 'cash' as const }
    pos.payDebt(cash)
    const before = snapshot(); restart()
    pos.payDebt(transfer); pos.payDebt(cash)
    expect(pos.createReturn(request)).toEqual(refund); expect(snapshot()).toEqual(before)
    expect(pos.getCustomer(customer).debt_balance).toBe(0)
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(1900)
    const period = { date_from: '2026-09-28T00:00:00.000Z', date_to: '2026-09-28T23:59:59.999Z' }
    expect(pos.dashboardSummary(period).analytics).toMatchObject({ total_revenue: 2000, cogs: 1200, gross_profit: 800, refund_total: 1000 })
    expect(pos.soldItemsReport(period)[0]).toMatchObject({ product_id: product, qty_sold: 3, qty_returned: 1, qty_net: 2, net_revenue: 2000 })
  })
  it('rejects salary payment from another cashier shift without changing any ledger', () => {
    bonus(); const before = snapshot()
    expect(() => staff.dailyPayout(payout({ user_id: 'other' }))).toThrow()
    expect(snapshot()).toEqual(before)
  })
  it('does not bypass the available-cash check through an unknown fund source', () => {
    bonus(2000); const before = snapshot()
    expect(() => staff.dailyPayout(payout({ fund_source: 'unknown' as any }))).toThrow()
    expect(snapshot()).toEqual(before)
  })
  it('rejects cashbox salary over the balance; owner funds pay it with zero net drawer movement', () => {
    bonus(2000)
    expect(() => staff.dailyPayout(payout())).toThrow('недостатньо')
    const request = payout({ fund_source: 'owner_funds' as const })
    const first = staff.dailyPayout(request), before = snapshot(); restart()
    expect(staff.dailyPayout(request)).toEqual(first); expect(snapshot()).toEqual(before)
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(1000)
    expect(staff.dailySummary(workDate)[0]).toMatchObject({ earned: 2000, paid: 2000, balance: 0 })
    expect(db.prepare("SELECT type,amount FROM cash_operations WHERE source='owner_funds' ORDER BY rowid").all())
      .toEqual([{ type: 'cash_in', amount: 2000 }, { type: 'salary_payout', amount: 2000 }])
  })
  it('rolls back owner contribution, payout and replay receipt when the salary outbox fails', () => {
    bonus(2000); const request = payout({ fund_source: 'owner_funds' as const }), before = snapshot()
    db.exec("CREATE TRIGGER settlement_outbox_failure BEFORE INSERT ON sync_outbox WHEN NEW.operation_type='salary_payment.created' BEGIN SELECT RAISE(ABORT, 'test outbox failure'); END")
    expect(() => staff.dailyPayout(request)).toThrow('test outbox failure')
    expect(snapshot()).toEqual(before)
    db.exec('DROP TRIGGER settlement_outbox_failure'); restart()
    expect(staff.dailyPayout(request).amount).toBe(2000)
  })
  it('does not alter a closed cash shift by deleting its historical salary payout', () => {
    const payment = staff.createSalary({ employee_id: 'worker', amount: 500, type: 'advance', method: 'cash',
      work_date: workDate, shift_id: shift, user_id: 'cashier' })
    pos.closeShift('cashier', 500, null, shift)
    const before = snapshot()
    expect(() => staff.deleteSalary(payment.id)).toThrow()
    expect(snapshot()).toEqual(before)
  })
  it('still permits correcting a manual salary entry while its cash shift is open', () => {
    const payment = staff.createSalary({ employee_id: 'worker', amount: 500, type: 'advance', method: 'cash',
      work_date: workDate, shift_id: shift, user_id: 'cashier' })
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(500)
    staff.deleteSalary(payment.id)
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(1000)
    expect(staff.dailySummary(workDate)).toEqual([])
  })
  it('returns the exact newly inserted salary even when it is outside the first history page', () => {
    const timestamp = '2026-09-29T10:00:00Z'
    db.transaction(() => {
      const insert = db.prepare("INSERT INTO salary_payments(id,tenant_id,employee_id,employee_name,amount,type,method,period,work_date,source,created_at,updated_at) VALUES (?,?,'worker','worker',1,'bonus','cash','2026-09',?,'manual',?,?)")
      for (let index = 0; index < 201; index++) insert.run('prior-' + index, tenant, workDate, timestamp, timestamp)
    })
    // A clock correction or an imported history must not hide the result of this write.
    const result = bonus(500)
    expect(result).toMatchObject({ employee_id: 'worker', amount: 500, type: 'bonus' })
    const outbox = db.prepare("SELECT payload_json FROM sync_outbox WHERE aggregate_id=? AND operation_type='salary_payment.created'").get(result.id) as { payload_json: string }
    expect(JSON.parse(outbox.payload_json)).toMatchObject({ id: result.id, amount: 500 })
  })
  it('replays the original partial tire cash handover result after another payment and restart', () => {
    tireWork(); const request = handover()
    const first = staff.tireCashHandover(request)
    expect(first).toEqual({ amount: 1000, remaining: 35000 })
    staff.tireCashHandover(handover({ amount: 2000 }))
    const before = snapshot(); restart()
    expect(staff.tireCashHandover(request)).toEqual(first); expect(snapshot()).toEqual(before)
    expect(staff.tireServiceReport(workDate).data[0].cash_pending).toBe(33000)
  })
  it('rejects a changed handover request that reuses the same operation ID', () => {
    tireWork(); const request = handover(); staff.tireCashHandover(request)
    const before = snapshot(); restart()
    expect(() => staff.tireCashHandover({ ...request, amount: 2000 })).toThrow()
    expect(snapshot()).toEqual(before)
  })
  it('does not mistake an unrelated cash operation for a completed tire handover', () => {
    tireWork()
    const id = randomUUID()
    pos.createCashOperation({ operation_id: id, shift_id: shift, type: 'in', amount: 1000 })
    // Existing cash-row IDs and replay IDs are independent in the general drawer API.
    const row = db.prepare('SELECT id FROM cash_operations ORDER BY rowid DESC LIMIT 1').get() as { id: string }
    const before = snapshot()
    expect(() => staff.tireCashHandover(handover({ operation_id: row.id }))).toThrow()
    expect(snapshot()).toEqual(before)
  })
  it('safely adopts a pre-upgrade handover and rejects a deleted one without reposting it', () => {
    tireWork(); const request = handover()
    staff.tireCashHandover(request)
    db.prepare('DELETE FROM app_meta WHERE key=?').run('mutation:tire-handover:' + tenant + ':' + request.operation_id)
    restart()
    expect(staff.tireCashHandover(request)).toEqual({ amount: 1000, remaining: 35000 })
    expect(db.prepare('SELECT COUNT(*) n FROM cash_operations WHERE id=?').get(request.operation_id)).toEqual({ n: 1 })
    db.prepare('DELETE FROM app_meta WHERE key=?').run('mutation:tire-handover:' + tenant + ':' + request.operation_id)
    db.prepare('UPDATE cash_operations SET deleted_at=? WHERE id=?').run(new Date().toISOString(), request.operation_id)
    const before = snapshot()
    expect(() => staff.tireCashHandover(request)).toThrow()
    expect(snapshot()).toEqual(before)
  })
  it('rolls back a failed handover and permits the exact retry', () => {
    tireWork(); const request = handover(), before = snapshot()
    db.exec("CREATE TRIGGER settlement_handover_failure BEFORE INSERT ON sync_outbox WHEN NEW.operation_type='cash_operation.created' BEGIN SELECT RAISE(ABORT, 'test handover failure'); END")
    expect(() => staff.tireCashHandover(request)).toThrow('test handover failure')
    expect(snapshot()).toEqual(before)
    db.exec('DROP TRIGGER settlement_handover_failure'); restart()
    expect(staff.tireCashHandover(request)).toEqual({ amount: 1000, remaining: 35000 })
  })
  it('does not silently round fractional kopecks in a handover', () => {
    tireWork(); const before = snapshot()
    expect(() => staff.tireCashHandover(handover({ amount: 1000.4 }))).toThrow()
    expect(snapshot()).toEqual(before)
  })
  it('rejects a tire handover to another cashier shift', () => {
    tireWork(); const before = snapshot()
    expect(() => staff.tireCashHandover(handover({ user_id: 'other' }))).toThrow()
    expect(snapshot()).toEqual(before)
  })
  it('does not pay tire salary before its existing two-day maturity even after full handover', () => {
    tireWork(); staff.tireCashHandover(handover({ amount: 36000 }))
    vi.setSystemTime(new Date('2026-09-27T10:00:00Z'))
    const before = snapshot()
    expect(() => staff.dailyPayout(payout({ employee_id: 'tire' }))).toThrow('2026-09-28')
    expect(snapshot()).toEqual(before)
  })
  it('keeps a late handover on its work date and allows only one mature salary payout', () => {
    tireWork()
    expect(() => staff.dailyPayout(payout({ employee_id: 'tire' }))).toThrow('внесіть')
    staff.tireCashHandover(handover({ amount: 36000 }))
    const request = payout({ employee_id: 'tire' })
    const first = staff.dailyPayout(request)
    expect(first.amount).toBe(12600)
    const before = snapshot(); restart()
    expect(staff.dailyPayout(request)).toEqual(first); expect(snapshot()).toEqual(before)
    expect(staff.tireServiceReport(workDate).data[0]).toMatchObject({ cash_pending: 0, earned: 12600, paid: 12600, due: 0 })
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(24400)
    expect(staff.dailySummary('2026-09-28')).toEqual([])
  })
})
