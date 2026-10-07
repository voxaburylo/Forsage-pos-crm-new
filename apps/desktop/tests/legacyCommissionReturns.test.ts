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
import { LocalProblemRepository } from '../src/repositories/problemRepository'
import { LocalOrderRepository } from '../src/repositories/orderRepository'

describe('approved legacy commission policy: exact correction or review, never current rates', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository, staff: LocalStaffRepository
  let shift: string, product: string, second: string
  function connect() { db = new LocalDatabase(root); pos = new LocalPosRepository(db); staff = new LocalStaffRepository(db) }
  function restart() { db.close(); connect() }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-28T10:00:00Z'))
    root = mkdtempSync(path.join(tmpdir(), 'forsage-legacy-commission-')); connect()
    for (const id of ['worker', 'other']) db.prepare("INSERT INTO staff_users(id,tenant_id,full_name,role,is_active,base_rate,created_at,updated_at) VALUES (?,?,?,'manager',1,0,?,?)")
      .run(id, tenant, id, new Date().toISOString(), new Date().toISOString())
    shift = pos.openShift({ cashier_id: 'cashier', opening_cash: 100000 })
    const catalog = new LocalCatalogRepository(db)
    product = catalog.upsertProduct({ id: randomUUID(), sku: 'LEGACY-A', name: 'Перший контрольний товар', qty_on_hand: 10, retail_price: 1000, purchase_price: 600 }).id
    second = catalog.upsertProduct({ id: randomUUID(), sku: 'LEGACY-B', name: 'Другий контрольний товар', qty_on_hand: 10, retail_price: 1000, purchase_price: 600 }).id
  })
  afterEach(() => {
    db.close(); vi.useRealTimers()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-legacy-commission-')) rmSync(root, { recursive: true, force: true })
  })
  function rule(extra: any = {}) { return staff.createCommissionRule({ user_id: 'worker', rule_type: 'pos_sales', pct_from_revenue: 10, pct_from_profit: 0, ...extra }) }
  function oldReceipt(id: string) { db.prepare('DELETE FROM app_meta WHERE key=?').run('commission-basis:v1:' + tenant + ':' + id) }
  function checkout(input: any = {}, keepBasis = false) {
    const result = pos.checkout({ client_operation_id: randomUUID(), cashier_id: 'cashier', manager_id: 'worker', shift_id: shift,
      items: [{ product_id: product, qty: 1, unit_price: 1000 }], payments: [{ method: 'cash', amount: 1000 }], ...input })
    if (!keepBasis) oldReceipt(result.sale_id)
    return result.sale_id
  }
  function multi() { return checkout({ items: [{ product_id: product, qty: 1, unit_price: 1000 }, { product_id: second, qty: 1, unit_price: 1000 }],
    payments: [{ method: 'cash', amount: 2000 }] }) }
  function request(id: string, qty = 1, productId = product) {
    const line = pos.getSaleForReturn(id).items.find((item: any) => item.product_id === productId)
    return { client_operation_id: randomUUID(), sale_id: id, approved_by: 'cashier', shift_id: shift,
      refund_method: 'cash' as const, stock_action: 'return_to_stock' as const,
      items: [{ sale_item_id: line.id, product_id: line.product_id, quantity: qty }] }
  }
  function refund(id: string, qty = 1, productId = product) { return pos.createReturn(request(id, qty, productId)) }
  function fullRefund(id: string) {
    const input = request(id)
    input.items = pos.getSaleForReturn(id).items.filter((item: any) => item.available_qty > 0)
      .map((item: any) => ({ sale_item_id: item.id, product_id: item.product_id, quantity: item.available_qty }))
    return pos.createReturn(input)
  }
  function earned(worker = 'worker') { return Number((db.prepare("SELECT COALESCE(SUM(amount),0) n FROM salary_payments WHERE tenant_id=? AND employee_id=? AND type='bonus' AND deleted_at IS NULL").get(tenant, worker) as { n: number }).n) }
  function warnings() { return new LocalProblemRepository(db).list().filter(item => item.code === 'salary.legacy_commission_review') }
  function snapshot() { return Object.fromEntries(['sales','sale_items','products','cash_operations','salary_payments','customer_returns','customer_return_items','inventory_movements','sync_outbox','app_meta','problem_log'].map(table => [table, db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()])) }

  it.each(['changed', 'deleted', 'inactive', 'archived'])('uses the original old-receipt award after its rule/employee is %s', change => {
    const r = rule(), id = checkout(), original = db.prepare("SELECT * FROM salary_payments WHERE source='commission'").get()
    if (change === 'changed') db.prepare('UPDATE commission_rules SET pct_from_revenue=90').run()
    if (change === 'deleted') staff.deleteCommissionRule(r.id)
    if (change === 'inactive') db.prepare("UPDATE staff_users SET is_active=0 WHERE id='worker'").run()
    if (change === 'archived') db.prepare("UPDATE staff_users SET deleted_at=? WHERE id='worker'").run(new Date().toISOString())
    restart(); refund(id)
    expect(earned()).toBe(0); expect(warnings()).toEqual([])
    expect(db.prepare("SELECT * FROM salary_payments WHERE source='commission'").get()).toEqual(original)
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(100000)
  })
  it('uses cumulative rounding for an old single-line receipt', () => {
    rule(); const id = checkout({ items: [{ product_id: product, qty: 3, unit_price: 5 }], payments: [{ method: 'cash', amount: 15 }] })
    expect(earned()).toBe(2)
    for (const amount of [1, 1, 0]) { refund(id); restart(); expect(earned()).toBe(amount) }
    expect(warnings()).toEqual([])
  })
  it('does not invent a deduction if there was no initial award', () => {
    const id = checkout(); rule()
    refund(id); expect(earned()).toBe(0); expect(warnings()).toEqual([])
  })
  it('reverses all original awards on an unambiguous full multi-line return', () => {
    rule(); rule({ user_id: 'other', rule_type: 'total_cashbox', pct_from_revenue: 25 })
    const id = multi()
    db.prepare('UPDATE commission_rules SET pct_from_revenue=90').run()
    fullRefund(id)
    expect(earned()).toBe(0); expect(earned('other')).toBe(0); expect(warnings()).toEqual([])
  })
  it('completes an ambiguous return and records a readable review instead of guessing salary', () => {
    rule(); const id = multi(), result = refund(id)
    expect(result.refund_kopecks).toBe(1000); expect(earned()).toBe(200)
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(101000)
    expect(new LocalCatalogRepository(db).findById(product)?.qty_on_hand).toBe(10)
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatchObject({ severity: 'warning', entity_type: 'customer_return', entity_id: result.id })
    expect(warnings()[0].title).toContain(pos.getSaleForReturn(id).sale.sale_number)
    expect(warnings()[0].detail).toContain('Зарплату автоматично не змінено')
    expect(warnings()[0].detail).not.toContain('Відбиток')
  })
  it('never resumes automatic deductions after manual review, even if its warning was closed', () => {
    rule(); const id = multi(); refund(id)
    const [warning] = warnings(); expect(warning).toBeDefined()
    new LocalProblemRepository(db).resolve(warning.id)
    staff.createSalary({ employee_id: 'worker', amount: 100, type: 'penalty', method: 'cash', work_date: '2026-09-28' })
    restart(); refund(id, 1, second)
    expect(earned()).toBe(200); expect(warnings()).toHaveLength(1)
    expect(db.prepare("SELECT COUNT(*) n FROM salary_payments WHERE source='commission_reversal'").get()).toEqual({ n: 0 })
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(100000)
  })
  it('does not duplicate a pending review on retry after restart', () => {
    rule(); const id = multi(), input = request(id), result = pos.createReturn(input)
    restart(); const before = snapshot()
    expect(pos.createReturn(input)).toEqual(result)
    expect(staff.recordReturnCommissionReversals(result.id, id, input.items)).toEqual([])
    expect(snapshot()).toEqual(before); expect(warnings()).toHaveLength(1)
    expect(warnings()[0].occurrences).toBe(1)
  })
  it('deducts only the remainder after a prior recorded partial reversal', () => {
    rule(); const id = checkout({ items: [{ product_id: product, qty: 2, unit_price: 1000 }], payments: [{ method: 'cash', amount: 2000 }] }, true)
    refund(id); oldReceipt(id)
    db.prepare('UPDATE commission_rules SET pct_from_revenue=90').run()
    refund(id); expect(earned()).toBe(0); expect(warnings()).toEqual([])
    expect(db.prepare("SELECT amount FROM salary_payments WHERE source='commission_reversal' ORDER BY rowid").all()).toEqual([{ amount: -100 }, { amount: -100 }])
  })
  it('does not repair an already excessive historical deduction without review', () => {
    rule(); const id = checkout({ items: [{ product_id: product, qty: 2, unit_price: 1000 }], payments: [{ method: 'cash', amount: 2000 }] }, true)
    refund(id); oldReceipt(id); db.prepare("UPDATE salary_payments SET amount=-900 WHERE source='commission_reversal'").run()
    const before = earned(); refund(id)
    expect(earned()).toBe(before); expect(warnings()).toHaveLength(1)
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(100000)
  })
  it('finds an original commission linked only to an archived order', () => {
    rule({ rule_type: 'order_sales' })
    const orders = new LocalOrderRepository(db)
    const order = orders.saveOrder({ manager_id: 'worker', items: [{ product_id: product, name: 'Замовлення', qty: 1,
      buy_price: 600, sell_price: 1000, item_status: 'arrived' }] })
    orders.addPayment(order.id, { user_id: 'cashier', shift_id: shift, amount: 1000, method: 'cash' })
    const id = orders.completeOrder(order.id, { user_id: 'cashier', shift_id: shift }).data.sale_id
    oldReceipt(id)
    db.prepare("UPDATE salary_payments SET commission_source_sale_id=NULL WHERE source='commission'").run()
    db.prepare('UPDATE customer_orders SET deleted_at=? WHERE id=?').run(new Date().toISOString(), order.id)
    staff.deleteCommissionRule(staff.listCommissionRules()[0].id)
    refund(id); expect(earned()).toBe(0); expect(warnings()).toEqual([])
  })
  it('does not guess the commission when a non-returnable free-price line remains', () => {
    rule(); const id = checkout({ items: [{ product_id: product, qty: 1, unit_price: 1000 },
      { description: 'Послуга', qty: 1, unit_price: 1000 }], payments: [{ method: 'cash', amount: 2000 }] })
    refund(id); expect(earned()).toBe(200); expect(warnings()).toHaveLength(1)
  })
  it('keeps customer debt and stock correct while an ambiguous salary waits for review', () => {
    rule(); const customer = pos.saveCustomer({ full_name: 'Контрольний клієнт', phone: '0501112233' }).data.id
    const id = checkout({ customer_id: customer, items: [{ product_id: product, qty: 1, unit_price: 1000 },
      { product_id: second, qty: 1, unit_price: 1000 }], payments: [{ method: 'debt', amount: 2000 }] })
    pos.createReturn({ ...request(id), refund_method: 'debt_reduction' })
    expect(db.prepare('SELECT debt_balance FROM customers WHERE id=?').get(customer)).toEqual({ debt_balance: 1000 })
    expect(earned()).toBe(200); expect(warnings()).toHaveLength(1)
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(100000)
  })
  it('records an exact old-receipt correction on the return day, not the sale day', () => {
    rule(); const id = checkout()
    vi.setSystemTime(new Date('2026-09-29T21:30:00Z')); db.prepare('UPDATE commission_rules SET pct_from_revenue=90').run()
    refund(id)
    expect(staff.dailySummary('2026-09-28')[0].earned).toBe(100)
    expect(staff.dailySummary('2026-09-30')[0].earned).toBe(-100)
  })
  it('preserves the review hold in a verified backup even after its warning was closed', async () => {
    rule(); const id = multi(); refund(id)
    new LocalProblemRepository(db).resolve(warnings()[0].id)
    const backup = await db.backupNow(), restoredRoot = path.join(root, 'restored')
    mkdirSync(path.join(restoredRoot, 'data'), { recursive: true })
    copyFileSync(backup, path.join(restoredRoot, 'data', 'forsage.db'))
    const original = snapshot(), restored = new LocalDatabase(restoredRoot)
    try {
      const restoredPos = new LocalPosRepository(restored)
      const input = request(id, 1, second)
      restoredPos.createReturn(input)
      expect(restored.prepare("SELECT COUNT(*) n FROM salary_payments WHERE source='commission_reversal'").get()).toEqual({ n: 0 })
      expect(new LocalProblemRepository(restored).list().filter(item => item.code === 'salary.legacy_commission_review')).toHaveLength(1)
      expect(restoredPos.getExpectedCash('cashier')?.expected_amount).toBe(100000)
      expect(snapshot()).toEqual(original)
    } finally { restored.close() }
  })
  it('keeps fractional old-receipt quantities and kopeck rounding exact after restart', () => {
    rule(); const id = checkout({ items: [{ product_id: product, qty: 0.3, unit_price: 101 }], payments: [{ method: 'cash', amount: 30 }] })
    expect(earned()).toBe(3)
    for (const amount of [2, 1, 0]) { refund(id, 0.1); restart(); expect(earned()).toBe(amount) }
    expect(warnings()).toEqual([])
    expect(new LocalCatalogRepository(db).findById(product)?.qty_on_hand).toBe(10)
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(100000)
  })
  it("does not charge a newly configured employee for someone else's old sale", () => {
    rule(); const id = checkout()
    rule({ user_id: 'other', rule_type: 'total_cashbox', pct_from_revenue: 90 })
    refund(id)
    expect(earned()).toBe(0); expect(earned('other')).toBe(0)
    expect(db.prepare("SELECT employee_id,amount FROM salary_payments WHERE source='commission_reversal'").all())
      .toEqual([{ employee_id: 'worker', amount: -100 }])
  })
  it('treats two differently priced lines of the same product as ambiguous', () => {
    rule(); const id = checkout({ items: [{ product_id: product, qty: 1, unit_price: 1000 },
      { product_id: product, qty: 1, unit_price: 2000 }], payments: [{ method: 'cash', amount: 3000 }] })
    refund(id); expect(earned()).toBe(300); expect(warnings()).toHaveLength(1)
  })
  it('does not silently recreate an archived original award', () => {
    rule(); const id = checkout()
    db.prepare("UPDATE salary_payments SET deleted_at=? WHERE source='commission'").run(new Date().toISOString())
    refund(id)
    expect(earned()).toBe(0); expect(warnings()).toHaveLength(1)
    expect(db.prepare("SELECT COUNT(*) n FROM salary_payments WHERE source='commission_reversal'").get()).toEqual({ n: 0 })
  })
  it.each(['salary', 'review-log', 'review-marker', 'decision-marker'])('rolls back all writes on technical failure of %s, then safely retries', failure => {
    rule(); const id = failure === 'salary' ? checkout() : multi()
    if (failure === 'salary') db.exec("CREATE TRIGGER test_failure BEFORE INSERT ON sync_outbox WHEN NEW.aggregate_type='salary_payment' BEGIN SELECT RAISE(ABORT,'salary test failure'); END")
    if (failure === 'review-log') db.exec("CREATE TRIGGER test_failure BEFORE INSERT ON problem_log BEGIN SELECT RAISE(ABORT,'review test failure'); END")
    if (failure === 'review-marker') db.exec("CREATE TRIGGER test_failure BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'commission-legacy-review:v1:%' BEGIN SELECT RAISE(ABORT,'marker test failure'); END")
    if (failure === 'decision-marker') db.exec("CREATE TRIGGER test_failure BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'commission-legacy-return:v1:%' BEGIN SELECT RAISE(ABORT,'decision test failure'); END")
    const before = snapshot(), input = request(id)
    expect(() => pos.createReturn(input)).toThrow()
    expect(snapshot()).toEqual(before)
    db.exec('DROP TRIGGER test_failure'); pos.createReturn(input)
    if (failure === 'salary') { expect(earned()).toBe(0); expect(warnings()).toEqual([]) }
    else { expect(earned()).toBe(200); expect(warnings()).toHaveLength(1) }
  })
})
