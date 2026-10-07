import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalStaffRepository } from '../src/repositories/staffRepository'
import { LocalOrderRepository } from '../src/repositories/orderRepository'

describe('readiness: commissions follow the original receipt, not mutable settings', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository, staff: LocalStaffRepository
  let shift: string, product: string
  function connect() { db = new LocalDatabase(root); pos = new LocalPosRepository(db); staff = new LocalStaffRepository(db) }
  function restart() { db.close(); connect() }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-28T10:00:00Z'))
    root = mkdtempSync(path.join(tmpdir(), 'forsage-readiness-commission-')); connect()
    for (const id of ['worker', 'other']) db.prepare("INSERT INTO staff_users(id,tenant_id,full_name,role,is_active,base_rate,created_at,updated_at) VALUES (?,?,?,'manager',1,0,?,?)")
      .run(id, tenant, id, new Date().toISOString(), new Date().toISOString())
    shift = pos.openShift({ cashier_id: 'cashier', opening_cash: 100000 })
    product = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: 'COMMISSION', name: 'Контрольний товар', qty_on_hand: 10, purchase_price: 600, retail_price: 1000 }).id
  })
  afterEach(() => {
    db.close(); vi.useRealTimers()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-readiness-commission-')) rmSync(root, { recursive: true, force: true })
  })
  function rule(input: any = {}) { return staff.createCommissionRule({ user_id: 'worker', rule_type: 'pos_sales', pct_from_revenue: 10, pct_from_profit: 0, ...input }) }
  function sale(input: any = {}) {
    return pos.checkout({ client_operation_id: randomUUID(), cashier_id: 'cashier', manager_id: 'worker', shift_id: shift,
      items: [{ product_id: product, qty: 1, unit_price: 1000 }], payments: [{ method: 'cash', amount: 1000 }], ...input })
  }
  function refund(saleId: string, quantity = 1, itemIndex = 0) {
    const item = pos.getSaleForReturn(saleId).items[itemIndex]
    return pos.createReturn({ client_operation_id: randomUUID(), sale_id: saleId, approved_by: 'cashier', shift_id: shift,
      refund_method: 'cash', stock_action: 'return_to_stock', items: [{ sale_item_id: item.id, product_id: item.product_id, quantity }] })
  }
  function earned(employee = 'worker') {
    return Number((db.prepare("SELECT COALESCE(SUM(amount),0) amount FROM salary_payments WHERE tenant_id=? AND employee_id=? AND type IN ('salary','bonus') AND deleted_at IS NULL").get(tenant, employee) as { amount: number }).amount)
  }
  function snapshot() {
    return Object.fromEntries(['sales','sale_items','products','cash_operations','salary_payments','customer_returns','customer_return_items','inventory_movements','sync_outbox','app_meta']
      .map(table => [table, db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]))
  }
  it('uses paid line revenue after both item and receipt discounts', () => {
    rule({ pct_from_revenue: 10, pct_from_profit: 50 })
    const receipt = sale({ discount: 100, items: [{ product_id: product, qty: 1, unit_price: 1000, discount: 100 }],
      payments: [{ method: 'cash', amount: 800 }] })
    expect(earned()).toBe(180) // 800 × 10% + (800 - 600) × 50%
    refund(receipt.sale_id)
    expect(earned()).toBe(0)
  })
  it.each(['changed', 'deleted', 'inactive', 'archived'])('reverses the saved amount after the rule/worker is %s', change => {
    const savedRule = rule(), receipt = sale()
    expect(earned()).toBe(100)
    if (change === 'changed') db.prepare('UPDATE commission_rules SET pct_from_revenue=95 WHERE id=?').run(savedRule.id)
    if (change === 'deleted') staff.deleteCommissionRule(savedRule.id)
    if (change === 'inactive') db.prepare("UPDATE staff_users SET is_active=0 WHERE id='worker'").run()
    if (change === 'archived') db.prepare("UPDATE staff_users SET deleted_at=? WHERE id='worker'").run(new Date().toISOString())
    restart(); refund(receipt.sale_id)
    expect(earned()).toBe(0)
  })
  it('never charges a worker who had no original accrual when a new rule was added later', () => {
    const receipt = sale(); rule()
    expect(earned()).toBe(0)
    refund(receipt.sale_id)
    expect(earned()).toBe(0)
    expect(db.prepare('SELECT COUNT(*) n FROM salary_payments').get()).toEqual({ n: 0 })
  })
  it('does not retroactively add an accrual to a saved zero-commission receipt', () => {
    const receipt = sale(); rule()
    expect(staff.recordSaleCommissions(receipt.sale_id)).toEqual([])
    expect(earned()).toBe(0)
  })
  it('does not accrue a second employee when the rules change and the calculation is replayed', () => {
    rule(); const receipt = sale()
    rule({ user_id: 'other', rule_type: 'total_cashbox', pct_from_revenue: 50 })
    restart(); expect(staff.recordSaleCommissions(receipt.sale_id)).toEqual([])
    expect(earned('other')).toBe(0)
    refund(receipt.sale_id)
    expect(earned('worker')).toBe(0); expect(earned('other')).toBe(0)
  })
  it('returns only two earned kopecks across three separate partial returns', () => {
    rule()
    const receipt = sale({ items: [{ product_id: product, qty: 3, unit_price: 5 }], payments: [{ method: 'cash', amount: 15 }] })
    expect(earned()).toBe(2)
    refund(receipt.sale_id); expect(earned()).toBe(1)
    restart(); refund(receipt.sale_id); expect(earned()).toBe(1)
    refund(receipt.sale_id); expect(earned()).toBe(0)
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(100000)
  })
  it('preserves per-line rates and rounded money for fractional quantities', () => {
    rule()
    const receipt = sale({ items: [{ product_id: product, qty: 0.3, unit_price: 101 }], payments: [{ method: 'cash', amount: 30 }] })
    expect(earned()).toBe(3)
    db.prepare('UPDATE commission_rules SET pct_from_revenue=90').run()
    for (let index = 0; index < 3; index++) { refund(receipt.sale_id, 0.1); restart(); expect(earned()).toBe(2-index) }
  })
  it('preserves the original per-product rate after brand/category changes', () => {
    const catalog = new LocalCatalogRepository(db)
    // Categories are fixture records, never shop data.
    db.prepare("INSERT INTO categories(id,tenant_id,name,created_at,updated_at) VALUES ('a',?,'A',?,?),('b',?,'B',?,?)")
      .run(tenant, new Date().toISOString(), new Date().toISOString(), tenant, new Date().toISOString(), new Date().toISOString())
    db.prepare("UPDATE products SET category_id='a' WHERE id=?").run(product)
    const second = catalog.upsertProduct({ id: randomUUID(), sku: 'OTHER', name: 'Інший', category_id: 'b', qty_on_hand: 10, retail_price: 1000 }).id
    rule({ category_id: 'a', pct_from_revenue: 20 }); rule({ category_id: 'b', pct_from_revenue: 5 })
    const receipt = sale({ items: [{ product_id: product, qty: 1, unit_price: 1000 }, { product_id: second, qty: 1, unit_price: 1000 }], payments: [{ method: 'cash', amount: 2000 }] })
    expect(earned()).toBe(250)
    db.prepare("UPDATE products SET category_id='b' WHERE id=?").run(product)
    const line = pos.getSaleForReturn(receipt.sale_id).items.find((item: any) => item.product_id === product)
    pos.createReturn({ client_operation_id: randomUUID(), sale_id: receipt.sale_id, approved_by: 'cashier', shift_id: shift,
      items: [{ sale_item_id: line.id, product_id: product, quantity: 1 }] })
    expect(earned()).toBe(50)
  })
  it('preserves the order commission through issue, settings change and return', () => {
    rule({ rule_type: 'order_sales' })
    const orders = new LocalOrderRepository(db)
    const order = orders.saveOrder({ manager_id: 'worker', items: [{ product_id: product, name: 'Замовлення', qty: 1, buy_price: 600, sell_price: 1000, item_status: 'arrived' }] })
    orders.addPayment(order.id, { user_id: 'cashier', shift_id: shift, amount: 1000, method: 'cash' })
    const receipt = orders.completeOrder(order.id, { user_id: 'cashier', shift_id: shift })
    expect(earned()).toBe(100)
    db.prepare('UPDATE commission_rules SET pct_from_revenue=90').run()
    restart(); refund(receipt.data.sale_id)
    expect(earned()).toBe(0)
  })
  it('does not reverse a paid salary cash movement; records the commission correction separately', () => {
    rule(); const receipt = sale()
    staff.dailyPayout({ operation_id: randomUUID(), employee_id: 'worker', user_id: 'cashier', shift_id: shift, work_date: '2026-09-28', method: 'cash' })
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(100900)
    db.prepare('UPDATE commission_rules SET pct_from_revenue=90').run()
    refund(receipt.sale_id)
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(99900)
    expect(staff.dailySummary('2026-09-28')[0]).toMatchObject({ earned: 0, paid: 100, balance: -100 })
  })
  it('records the correction on the return business day without rewriting the sale-day accrual', () => {
    rule(); const receipt = sale()
    vi.setSystemTime(new Date('2026-09-29T10:00:00Z'))
    db.prepare('UPDATE commission_rules SET pct_from_revenue=90').run()
    refund(receipt.sale_id)
    expect(staff.dailySummary('2026-09-28')[0].earned).toBe(100)
    expect(staff.dailySummary('2026-09-29')[0].earned).toBe(-100)
  })
  it('does not pay a commission on the refundable core deposit', () => {
    rule({ pct_from_revenue: 10, pct_from_profit: 50 })
    db.prepare('UPDATE products SET requires_core_return=1,core_deposit_amount=500 WHERE id=?').run(product)
    const receipt = sale({ discount: 100, items: [{ product_id: product, qty: 1, unit_price: 1000, discount: 100 }],
      payments: [{ method: 'cash', amount: 1300 }] })
    expect(earned()).toBe(180) // Goods 800; core deposit 500 is not earnings.
    expect(refund(receipt.sale_id).refund_kopecks).toBe(800)
    expect(earned()).toBe(0)
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(100500)
  })
  it('uses the issued order total after its saved discount', () => {
    rule({ rule_type: 'order_sales', pct_from_revenue: 10, pct_from_profit: 50 })
    const orders = new LocalOrderRepository(db)
    const order = orders.saveOrder({ manager_id: 'worker', items: [{ product_id: product,
      name: 'Замовлення', qty: 1, buy_price: 600, sell_price: 1000, item_status: 'arrived' }] })
    db.prepare('UPDATE customer_orders SET discount_amount=200 WHERE id=?').run(order.id)
    orders.addPayment(order.id, { user_id: 'cashier', shift_id: shift, amount: 800, method: 'cash' })
    const issued = orders.completeOrder(order.id, { user_id: 'cashier', shift_id: shift })
    expect(earned()).toBe(180)
    expect(staff.recordOrderCommissions(order.id)).toEqual([])
    refund(issued.data.sale_id); expect(earned()).toBe(0)
  })
  it('allocates a receipt discount across products and free-price lines without over-reversing', () => {
    rule()
    const receipt = sale({ discount: 200, items: [{ product_id: product, qty: 1, unit_price: 1000 },
      { description: 'Ручна послуга', qty: 1, unit_price: 1000 }], payments: [{ method: 'cash', amount: 1800 }] })
    expect(earned()).toBe(180)
    const result = refund(receipt.sale_id)
    expect(result.refund_kopecks).toBe(900); expect(earned()).toBe(90)
    expect(staff.recordSaleCommissions(receipt.sale_id)).toEqual([])
  })
  it('preserves independent personal and cashbox awards for multiple employees', () => {
    rule(); rule({ user_id: 'other', rule_type: 'total_cashbox', pct_from_revenue: 25 })
    const receipt = sale()
    expect(earned()).toBe(100); expect(earned('other')).toBe(250)
    db.prepare('UPDATE commission_rules SET pct_from_revenue=90').run()
    refund(receipt.sale_id, 0.5)
    expect(earned()).toBe(50); expect(earned('other')).toBe(125)
    restart(); refund(receipt.sale_id, 0.5)
    expect(earned()).toBe(0); expect(earned('other')).toBe(0)
  })
  it('keeps a zero award for a loss-making sale even after the cost and rule change', () => {
    rule({ pct_from_revenue: 0, pct_from_profit: 50 })
    const receipt = sale({ items: [{ product_id: product, qty: 1, unit_price: 500 }], payments: [{ method: 'cash', amount: 500 }] })
    expect(earned()).toBe(0)
    db.prepare('UPDATE products SET purchase_price=0 WHERE id=?').run(product)
    db.prepare('UPDATE commission_rules SET pct_from_revenue=10').run()
    expect(staff.recordSaleCommissions(receipt.sale_id)).toEqual([])
    refund(receipt.sale_id); expect(earned()).toBe(0)
  })
  it('never reverses more than the net award when a loss-making line reduced it', () => {
    rule({ pct_from_revenue: 0, pct_from_profit: 50 })
    const second = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: 'LOSS',
      name: 'Тестова збиткова позиція', qty_on_hand: 1, purchase_price: 400, retail_price: 300 }).id
    const receipt = sale({ items: [{ product_id: product, qty: 1, unit_price: 1000 },
      { product_id: second, qty: 1, unit_price: 300 }], payments: [{ method: 'cash', amount: 1300 }] })
    expect(earned()).toBe(150) // 200 from first line, less 50 from loss-making line.
    const lines = pos.getSaleForReturn(receipt.sale_id).items
    const lossIndex = lines.findIndex((row: any) => row.product_id === second)
    refund(receipt.sale_id, 1, lossIndex); expect(earned()).toBe(150)
    refund(receipt.sale_id, 1, 1-lossIndex); expect(earned()).toBe(0)
  })
  it('keeps the exact result when a committed return is retried after restart', () => {
    rule(); const receipt = sale(), item = pos.getSaleForReturn(receipt.sale_id).items[0]
    const input = { client_operation_id: randomUUID(), sale_id: receipt.sale_id, approved_by: 'cashier',
      shift_id: shift, refund_method: 'cash' as const, stock_action: 'return_to_stock' as const,
      items: [{ sale_item_id: item.id, product_id: product, quantity: 0.5 }] }
    const first = pos.createReturn(input); restart(); const before = snapshot()
    expect(pos.createReturn(input)).toEqual(first)
    expect(snapshot()).toEqual(before); expect(earned()).toBe(50)
  })
  it('does not move drawer cash for a card refund or for its commission reversal', () => {
    rule()
    const receipt = sale({ payments: [{ method: 'card', amount: 1000 }] }), line = pos.getSaleForReturn(receipt.sale_id).items[0]
    pos.createReturn({ client_operation_id: randomUUID(), sale_id: receipt.sale_id, approved_by: 'cashier',
      shift_id: shift, refund_method: 'terminal', stock_action: 'return_to_stock',
      items: [{ sale_item_id: line.id, product_id: product, quantity: 1 }] })
    expect(earned()).toBe(0); expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(100000)
  })
  it.each(['json', 'tenant', 'fractional-quantity', 'amount-sum', 'wrong-line', 'wrong-quantity'])('rolls back a return if its saved basis has %s damage', damage => {
    rule(); const receipt = sale()
    const key = 'commission-basis:v1:' + tenant + ':' + receipt.sale_id
    const raw = (db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(key) as { value_json: string }).value_json
    const damaged = JSON.parse(raw)
    if (damage === 'tenant') damaged.tenant_id = 'other-tenant'
    if (damage === 'fractional-quantity') damaged.employees[0].lines[0].quantity_units = 1.5
    if (damage === 'amount-sum') damaged.employees[0].lines[0].amount++
    if (damage === 'wrong-line') damaged.employees[0].lines[0].id = randomUUID()
    if (damage === 'wrong-quantity') damaged.employees[0].lines[0].quantity_units++
    db.prepare('UPDATE app_meta SET value_json=? WHERE key=?').run(damage === 'json' ? '{broken' : JSON.stringify(damaged), key)
    const before = snapshot()
    expect(() => refund(receipt.sale_id)).toThrow('розрахунок зарплати пошкоджений')
    expect(snapshot()).toEqual(before)
    db.prepare('UPDATE app_meta SET value_json=? WHERE key=?').run(raw, key)
    refund(receipt.sale_id); expect(earned()).toBe(0)
  })
  it('rejects a damaged empty basis if the receipt actually has an award', () => {
    rule(); const receipt = sale(), key = 'commission-basis:v1:' + tenant + ':' + receipt.sale_id
    db.prepare('UPDATE app_meta SET value_json=? WHERE key=?').run(JSON.stringify({
      version: 1, tenant_id: tenant, sale_id: receipt.sale_id, employees: [],
    }), key)
    const before = snapshot()
    expect(() => refund(receipt.sale_id)).toThrow('не відповідає збереженому розрахунку')
    expect(snapshot()).toEqual(before)
  })
  it('rolls back a return if the original award no longer matches its saved basis', () => {
    rule(); const receipt = sale()
    db.prepare("UPDATE salary_payments SET amount=999 WHERE source='commission'").run()
    const before = snapshot()
    expect(() => refund(receipt.sale_id)).toThrow('не відповідає збереженому розрахунку')
    expect(snapshot()).toEqual(before)
  })
  it('restores the historical basis from a verified full database backup', async () => {
    rule(); const receipt = sale()
    const backup = await db.backupNow(), restoredRoot = path.join(root, 'restored')
    mkdirSync(path.join(restoredRoot, 'data'), { recursive: true })
    copyFileSync(backup, path.join(restoredRoot, 'data', 'forsage.db'))
    const restored = new LocalDatabase(restoredRoot)
    try {
      restored.prepare('UPDATE commission_rules SET pct_from_revenue=90').run()
      const restoredPos = new LocalPosRepository(restored), line = restoredPos.getSaleForReturn(receipt.sale_id).items[0]
      restoredPos.createReturn({ sale_id: receipt.sale_id, approved_by: 'cashier', shift_id: shift,
        refund_method: 'cash', stock_action: 'return_to_stock', items: [{ sale_item_id: line.id, product_id: product, quantity: 1 }] })
      expect(restored.prepare("SELECT SUM(amount) total FROM salary_payments WHERE source IN ('commission','commission_reversal')").get()).toEqual({ total: 0 })
      expect(earned()).toBe(100) // Original test database was not replaced.
    } finally { restored.close() }
  })
  it.each(['sale', 'return'])('rolls back the entire %s if its salary outbox write fails', action => {
    rule(); const receipt = action === 'return' ? sale() : undefined
    db.exec("CREATE TRIGGER salary_outbox_failure BEFORE INSERT ON sync_outbox WHEN NEW.aggregate_type='salary_payment' BEGIN SELECT RAISE(ABORT,'salary outbox failure'); END")
    const before = snapshot()
    expect(() => action === 'sale' ? sale() : refund(receipt!.sale_id)).toThrow('salary outbox failure')
    expect(snapshot()).toEqual(before)
    db.exec('DROP TRIGGER salary_outbox_failure')
    if (action === 'sale') { sale(); expect(earned()).toBe(100) }
    else { refund(receipt!.sale_id); expect(earned()).toBe(0) }
  })
  it('rolls back the sale if its commission snapshot cannot be persisted', () => {
    rule(); const before = snapshot()
    db.exec("CREATE TRIGGER commission_snapshot_failure BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'commission-basis:v1:%' BEGIN SELECT RAISE(ABORT, 'snapshot failure'); END")
    expect(() => sale()).toThrow('snapshot failure')
    expect(snapshot()).toEqual(before)
    db.exec('DROP TRIGGER commission_snapshot_failure')
    expect(sale().sale_id).toBeTruthy()
  })
})
