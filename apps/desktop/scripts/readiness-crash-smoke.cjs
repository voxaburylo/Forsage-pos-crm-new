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
const { commitReceiving } = require('../dist/repositories/receivingCommit.js')
const safeRoot = root => path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('forsage-crash-test-')
function execute(db, spec) {
  if (spec.operation === 'receiving') return commitReceiving(db, spec.receiving)
  return spec.operation === 'checkout'
    ? new LocalPosRepository(db).checkout(spec.request)
    : new LocalSupplyRepository(db).postInvoice(spec.invoice)
}
function snapshot(db) {
  return Object.fromEntries(['products', 'product_barcodes', 'sales', 'sale_items', 'sale_payments', 'inventory_movements', 'cash_operations', 'shifts', 'sync_outbox', 'supply_invoices', 'supply_invoice_items', 'supplier_payments', 'app_meta']
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
    const product = new LocalCatalogRepository(db).saveProduct({ id: randomUUID(), sku: 'CRASH-TEST', name: 'Synthetic product', qty_on_hand: 10, retail_price: 1000, purchase_price: 500 })
    const invoice = supply.createInvoice({ items: [{ product_id: product.id, qty: 3, purchase_price: 500 }] })
    const spec = { operation, phase, invoice: invoice.id, request: { client_operation_id: randomUUID(), cashier_id: cashier, shift_id: shift,
      items: [{ product_id: product.id, qty: 3, unit_price: 1000 }], payments: [{ method: 'cash', amount: 3000 }] } }
    if (operation === 'receiving') spec.receiving = { operation_id: randomUUID(), invoice_id: randomUUID(), supplier_id: supply.saveSupplier({ name: 'Crash supplier' }).id,
      items: [{ client_key: 'row', product_id: product.id, product_name: product.name, sku: product.sku, qty: 3, purchase_price: 500, retail_price: 1000 }],
      payments: [{ amount: 1000, payment_method: 'cash', fund_source: 'cashbox', shift_id: shift }, { amount: 500, payment_method: 'cash', fund_source: 'owner_funds' }] }
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
    if (operation === 'checkout') {
      execute(db, spec)
      assert.equal(final.sales.length, 1)
      assert.equal(final.sale_items.length, 1)
      assert.equal(final.sale_payments.length, 1)
    } else if (operation === 'receiving') {
      assert.equal(execute(db, spec).id, spec.receiving.invoice_id)
      assert.equal(final.supplier_payments.length, 2)
    } else assert.throws(() => execute(db, spec), /вже проведено/)
    assert.deepEqual(snapshot(db), final, 'Retry modified a committed operation')
    assert.equal(new LocalCatalogRepository(db).findById(product.id).qty_on_hand, operation === 'checkout' ? 7 : 13)
    assert.equal(new LocalPosRepository(db).getExpectedCash(cashier).expected_amount, operation === 'checkout' ? 13000 : operation === 'receiving' ? 9000 : 10000)
    assert.equal(final.inventory_movements.length, before.inventory_movements.length + 1)
    console.log('PASS: ' + operation + ', kill ' + phase + ' commit, restart and retry; atomic stock/cash/outbox')
  } finally {
    if (child && !exited) { child.kill('SIGKILL'); await exitPromise }
    db?.close()
    if (safeRoot(root)) fs.rmSync(root, { recursive: true, force: true })
  }
}
async function main() {
  if (process.argv[2] === '--worker') return worker()
  for (const operation of ['checkout', 'invoice', 'receiving']) for (const phase of ['before', 'after']) await scenario(operation, phase)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
