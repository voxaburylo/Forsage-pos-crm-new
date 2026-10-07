// Deliberately kills only a child process using a synthetic temp database.
// Does not open shop data, access the network, start the UI or send print jobs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { randomUUID } = require('node:crypto')
const { LocalDatabase } = require('../dist/db/localDatabase.js')
const { LocalCatalogRepository } = require('../dist/repositories/catalogRepository.js')
const { LocalPosRepository } = require('../dist/repositories/posRepository.js')
const { LocalSupplyRepository } = require('../dist/repositories/supplyRepository.js')
const { LocalInventoryRepository } = require('../dist/repositories/inventoryRepository.js')
const { LocalWarehouseRepository } = require('../dist/repositories/warehouseRepository.js')
const { LocalOrderRepository } = require('../dist/repositories/orderRepository.js')
const { LocalStaffRepository } = require('../dist/repositories/staffRepository.js')
const { DEFAULT_TENANT_ID: tenant } = require('../dist/db/localTypes.js')
const { commitReceiving } = require('../dist/repositories/receivingCommit.js')
const safeRoot = root => path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('forsage-crash-test-')
function execute(db, spec) {
  if (spec.operation === 'order_payment') return new LocalOrderRepository(db).addPayment(spec.orderId, spec.settlement)
  if (spec.operation === 'order_issue') return new LocalOrderRepository(db).completeOrder(spec.orderId, spec.settlement)
  if (spec.operation === 'order_cancel') return new LocalOrderRepository(db).cancelOrder(spec.orderId, spec.settlement)
  if (spec.operation === 'salary_payout') return new LocalStaffRepository(db).dailyPayout(spec.settlement)
  if (spec.operation === 'tire_handover') return new LocalStaffRepository(db).tireCashHandover(spec.settlement)
  if (spec.operation === 'deposit_payout') return new LocalPosRepository(db).payOutCustomerDeposit(spec.settlement)
  if (spec.operation === 'receiving') return commitReceiving(db, spec.receiving)
  if (spec.operation === 'checkout' || spec.operation === 'fractional_checkout') return new LocalPosRepository(db).checkout(spec.request)
  if (['return', 'legacy_return', 'legacy_review'].includes(spec.operation)) return new LocalPosRepository(db).createReturn(spec.returnRequest)
  if (spec.operation === 'writeoff') return new LocalWarehouseRepository(db).createWriteoff(spec.writeoff)
  if (spec.operation === 'inventory') return new LocalInventoryRepository(db).complete(spec.session)
  if (spec.operation === 'invoice_cancel') return new LocalSupplyRepository(db).cancelInvoice(spec.invoice)
  if (spec.operation === 'invoice') return new LocalSupplyRepository(db).postInvoice(spec.invoice)
  throw Error('Unknown test operation')
}
function snapshot(db) {
  return Object.fromEntries(['products', 'product_barcodes', 'sales', 'sale_items', 'sale_payments', 'inventory_movements', 'cash_operations', 'shifts', 'sync_outbox', 'supply_invoices', 'supply_invoice_items', 'supplier_payments', 'app_meta', 'customer_returns', 'customer_return_items', 'writeoffs', 'writeoff_items', 'inventory_sessions', 'inventory_items', 'inventory_count_entries', 'customers', 'customer_deposit_transactions', 'customer_orders', 'customer_order_items', 'order_payments', 'stock_reserves', 'salary_payments', 'problem_log']
    .map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]))
}
function worker() {
  const root = path.resolve(process.argv[3])
  assert(safeRoot(root), 'Refusing non-test database')
  const spec = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'))
  const db = new LocalDatabase(root), transaction = db.transaction.bind(db)
  let depth = 0
  function checkpoint() {
    fs.writeFileSync(path.join(root, 'checkpoint'), spec.phase)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000)
    throw Error('Parent failed to kill test worker')
  }
  db.transaction = work => {
    const outer = depth++ === 0
    try {
      const result = transaction(() => {
        const value = work()
        if (outer && spec.phase === 'before') checkpoint()
        return value
      })
      if (outer && spec.phase === 'after') checkpoint()
      return result
    } finally { depth-- }
  }
  execute(db, spec)
  throw Error('Operation did not reach transaction checkpoint')
}
async function scenario(operation, phase) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-crash-test-'))
  let db, child, exitPromise, exited = false, stderr = ''
  try {
    db = new LocalDatabase(root)
    const pos = new LocalPosRepository(db), supply = new LocalSupplyRepository(db)
    const cashier = randomUUID(), shift = pos.openShift({ cashier_id: cashier, opening_cash: 10000 })
    const product = new LocalCatalogRepository(db).saveProduct({ id: randomUUID(), sku: 'CRASH-TEST', name: 'Synthetic product', qty_on_hand: operation === 'fractional_checkout' ? 0.3 : 10, retail_price: 1000, purchase_price: 500 })
    const invoice = supply.createInvoice({ items: [{ product_id: product.id, qty: 3, purchase_price: 500 }] })
    const spec = { operation, phase, invoice: invoice.id, request: { client_operation_id: randomUUID(), cashier_id: cashier, shift_id: shift,
      items: [{ product_id: product.id, qty: 3, unit_price: 1000 }], payments: [{ method: 'cash', amount: 3000 }] } }
    if (operation === 'receiving') spec.receiving = { operation_id: randomUUID(), invoice_id: randomUUID(), supplier_id: supply.saveSupplier({ name: 'Crash supplier' }).id,
      items: [{ client_key: 'row', product_id: product.id, product_name: product.name, sku: product.sku, qty: 3, purchase_price: 500, retail_price: 1000 }],
      payments: [{ amount: 1000, payment_method: 'cash', fund_source: 'cashbox', shift_id: shift }, { amount: 500, payment_method: 'cash', fund_source: 'owner_funds' }] }
    if (operation === 'fractional_checkout') {
      spec.request.items = [0.1, 0.2].map(qty => ({ product_id: product.id, qty, unit_price: 1000 }))
      spec.request.payments = [{ method: 'cash', amount: 300 }]
    }
    if (['return', 'legacy_return', 'legacy_review'].includes(operation)) {
      const timestamp = new Date().toISOString(), employee = randomUUID()
      db.prepare("INSERT INTO staff_users(id,tenant_id,full_name,role,is_active,base_rate,created_at,updated_at) VALUES (?,?,?,'manager',1,0,?,?)")
        .run(employee, tenant, 'Synthetic return employee', timestamp, timestamp)
      new LocalStaffRepository(db).createCommissionRule({ user_id: employee, rule_type: 'pos_sales', pct_from_revenue: 10, pct_from_profit: 0 })
      const sale = pos.checkout({ ...spec.request, manager_id: employee, client_operation_id: randomUUID(),
        items: (operation === 'legacy_review' ? [0.1, 0.2] : [0.3]).map(qty => ({ product_id: product.id, qty, unit_price: 1000 })),
        payments: [{ method: 'cash', amount: 300 }] })
      if (operation.startsWith('legacy_')) db.prepare('DELETE FROM app_meta WHERE key=?').run('commission-basis:v1:' + tenant + ':' + sale.sale_id)
      // Changing the live rate must not change the stored 30-kopeck original award.
      db.prepare('UPDATE commission_rules SET pct_from_revenue=90').run()
      const line = pos.getSaleForReturn(sale.sale_id).items[0]
      spec.returnRequest = { client_operation_id: randomUUID(), sale_id: sale.sale_id,
        approved_by: cashier, shift_id: shift, refund_method: 'cash', stock_action: 'return_to_stock',
        items: [{ sale_item_id: line.id, product_id: product.id, quantity: 0.1 }] }
    }
    if (operation === 'writeoff') spec.writeoff = { operation_id: randomUUID(), user_id: cashier, reason: 'damage',
      items: [{ product_id: product.id, qty: 0.1 }] }
    if (operation === 'inventory') {
      const inventory = new LocalInventoryRepository(db)
      spec.session = inventory.createSession({ name: 'Crash count' }).id
      inventory.startSession(spec.session)
      inventory.countProduct(spec.session, { product_id: product.id, qty: 0.3 })
    }
    if (operation === 'invoice_cancel') supply.postInvoice(invoice.id)
    if (['order_payment', 'order_issue', 'order_cancel', 'salary_payout', 'tire_handover', 'deposit_payout'].includes(operation)) {
      const timestamp = new Date().toISOString(), employee = randomUUID()
      db.prepare("INSERT INTO staff_users(id,tenant_id,full_name,role,is_active,base_rate,rate_period,created_at,updated_at) VALUES (?,?,?,'manager',1,0,'day',?,?)")
        .run(employee, tenant, 'Synthetic employee', timestamp, timestamp)
      const staff = new LocalStaffRepository(db), orders = new LocalOrderRepository(db)
      const customer = pos.saveCustomer({ full_name: 'Synthetic customer', phone: '0671112233' }).data.id
      spec.settlement = { user_id: cashier, shift_id: shift }
      if (operation.startsWith('order_')) {
        spec.orderId = orders.saveOrder({ manager_id: employee, customer_id: customer, items: [{
          product_id: product.id, name: product.name, qty: 1, sell_price: 1000, buy_price: 500, item_status: 'arrived',
        }] }).id
        staff.createCommissionRule({ user_id: employee, rule_type: 'order_sales', pct_from_revenue: 10, pct_from_profit: 0 })
        if (operation === 'order_payment') Object.assign(spec.settlement, { payment_id: randomUUID(), amount: 1000, method: 'cash' })
        else orders.addPayment(spec.orderId, { user_id: cashier, shift_id: shift, payment_id: randomUUID(), amount: 1000, method: 'cash' })
        if (operation === 'order_cancel') Object.assign(spec.settlement, { keep_as_credit: true })
      }
      if (operation === 'salary_payout') {
        const workDate = '2026-09-26'
        staff.createSalary({ employee_id: employee, amount: 2000, type: 'bonus', method: 'cash', work_date: workDate, user_id: cashier })
        Object.assign(spec.settlement, { operation_id: randomUUID(), employee_id: employee, work_date: workDate, method: 'cash', fund_source: 'owner_funds' })
      }
      if (operation === 'deposit_payout') {
        pos.addCustomerDeposit({ customer_id: customer, amount: 5000, method: 'cash', user_id: cashier, shift_id: shift })
        Object.assign(spec.settlement, { payout_id: randomUUID(), customer_id: customer, amount: 2000, method: 'cash' })
      }
      if (operation === 'tire_handover') {
        db.prepare("UPDATE staff_users SET role='tire_worker' WHERE id=?").run(employee)
        const workDate = '2026-09-26', completed = workDate + 'T16:00:00Z'
        const service = new LocalCatalogRepository(db).saveProduct({ id: randomUUID(), sku: 'POS-TIRE-SERVICE', name: 'Synthetic service', is_service: true, retail_price: 36000 })
        db.prepare("INSERT INTO sales(id,tenant_id,sale_number,cashier_id,manager_id,shift_id,status,total,payment_method,cash_amount,completed_at,created_at,updated_at) VALUES ('tire-sale',?,'TIRE-TEST',?,?,?,'completed',36000,'cash',36000,?,?,?)")
          .run(tenant, cashier, employee, shift, completed, completed, completed)
        db.prepare("INSERT INTO sale_items(id,tenant_id,sale_id,product_id,sku,qty,unit_price,total,created_at,updated_at) VALUES ('tire-line',?,'tire-sale',?,'POS-TIRE-SERVICE',1,36000,36000,?,?)")
          .run(tenant, service.id, completed, completed)
        Object.assign(spec.settlement, { operation_id: randomUUID(), employee_id: employee, work_date: workDate, amount: 1000 })
      }
      spec.customerId = customer
    }
    fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify(spec))
    const before = snapshot(db)
    db.close(); db = undefined
    child = spawn(process.execPath, [__filename, '--worker', root], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000) })
    exitPromise = once(child, 'exit').then(() => { exited = true })
    const deadline = Date.now() + 10000
    while (!fs.existsSync(path.join(root, 'checkpoint')) && !exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    assert(fs.existsSync(path.join(root, 'checkpoint')), 'No transaction checkpoint: ' + stderr)
    assert(child.kill('SIGKILL'), 'Failed to kill test worker')
    await exitPromise
    db = new LocalDatabase(root)
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    if (phase === 'before') { assert.deepEqual(snapshot(db), before); execute(db, spec) }
    const final = snapshot(db)
    if (operation === 'checkout' || operation === 'fractional_checkout') {
      execute(db, spec)
      assert.equal(final.sales.length, 1)
      assert.equal(final.sale_items.length, operation === 'fractional_checkout' ? 2 : 1)
      assert.equal(final.sale_payments.length, 1)
    } else if (operation === 'receiving') {
      assert.equal(execute(db, spec).id, spec.receiving.invoice_id)
      assert.equal(final.supplier_payments.length, 2)
    } else if (operation === 'invoice') assert.throws(() => execute(db, spec), /вже проведено/)
    else execute(db, spec)
    assert.deepEqual(snapshot(db), final, 'Retry modified a committed operation')
    const expected = {
      checkout: [7, 13000, 1], fractional_checkout: [0, 10300, 2],
      invoice: [13, 10000, 1], receiving: [13, 9000, 1],
      invoice_cancel: [10, 10000, 1], return: [9.8, 10200, 1], legacy_return: [9.8, 10200, 1], legacy_review: [9.8, 10200, 1],
      writeoff: [9.9, 10000, 1], inventory: [0.3, 10000, 1],
      order_payment: [10, 11000, 0], order_issue: [9, 11000, 1], order_cancel: [10, 11000, 0],
      salary_payout: [10, 10000, 0], tire_handover: [10, 11000, 0], deposit_payout: [10, 13000, 0],
    }[operation]
    assert.equal(new LocalCatalogRepository(db).findById(product.id).qty_on_hand, expected[0])
    assert.equal(new LocalPosRepository(db).getExpectedCash(cashier).expected_amount, expected[1])
    assert.equal(final.inventory_movements.length, before.inventory_movements.length + expected[2])
    if (operation === 'order_issue') {
      assert.equal(final.salary_payments.length, 1)
      assert.equal(final.salary_payments[0].amount, 100)
      assert.equal(final.salary_payments[0].commission_source_sale_id, final.sales[0].id)
    }
    if (['return', 'legacy_return', 'legacy_review'].includes(operation)) {
      assert.equal(final.customer_returns[0].shift_id, shift)
      const shiftReport = new LocalPosRepository(db).getShiftReport(cashier)
      assert.equal(shiftReport.total_sales, 1)
      assert.equal(shiftReport.gross_revenue, 300)
      assert.equal(shiftReport.refund_total, 100)
      assert.equal(shiftReport.total_revenue, 200)
      assert.equal(shiftReport.payment_received_total, 300)
      assert.equal(shiftReport.payment_net_total, 200)
      assert.equal(shiftReport.unassigned_refunds_count, 0)
      assert.equal(final.salary_payments.find(row => row.source === 'commission').amount, 30)
      assert.equal(final.app_meta.filter(row => row.key.startsWith('commission-basis:v1:')).length, operation === 'return' ? 1 : 0)
      const review = operation === 'legacy_review'
      assert.equal(final.salary_payments.length, review ? 1 : 2)
      if (!review) assert.equal(final.salary_payments.find(row => row.source === 'commission_reversal').amount, -10)
      assert.equal(final.app_meta.filter(row => row.key.startsWith('commission-legacy-return:v1:')).length, operation === 'return' ? 0 : 1)
      assert.equal(final.app_meta.filter(row => row.key.startsWith('commission-legacy-review:v1:')).length, review ? 1 : 0)
      assert.equal(final.problem_log.filter(row => row.code === 'salary.legacy_commission_review').length, review ? 1 : 0)
    }
    if (operation === 'salary_payout') {
      assert.equal(final.salary_payments.length, 2)
      assert.equal(final.cash_operations.filter(row => row.source === 'owner_funds').length, 2)
    }
    if (operation === 'order_cancel' || operation === 'deposit_payout') {
      assert.equal(new LocalPosRepository(db).getCustomerDeposit(spec.customerId).balance, operation === 'order_cancel' ? 1000 : 3000)
    }
    if (operation === 'tire_handover') assert.deepEqual(execute(db, spec), { amount: 1000, remaining: 35000 })
    console.log('PASS: ' + operation + ', kill ' + phase + ' commit, restart and retry; atomic stock/cash/outbox')
  } finally {
    if (child && !exited) { child.kill('SIGKILL'); await exitPromise }
    db?.close()
    if (safeRoot(root)) fs.rmSync(root, { recursive: true, force: true })
  }
}
async function main() {
  if (process.argv[2] === '--worker') return worker()
  for (const operation of ['checkout', 'fractional_checkout', 'invoice', 'receiving', 'invoice_cancel', 'return', 'legacy_return', 'legacy_review', 'writeoff', 'inventory', 'order_payment', 'order_issue', 'order_cancel', 'salary_payout', 'tire_handover', 'deposit_payout']) for (const phase of ['before', 'after']) await scenario(operation, phase)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
