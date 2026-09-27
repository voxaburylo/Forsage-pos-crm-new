// Isolated Electron/ASAR contract and persistence test. Never uses shop data or printers.
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const dist = path.resolve(__dirname, process.argv.includes('--packaged') ? '../release/win-unpacked/resources/app.asar/dist' : '../dist')
const { LocalDatabase } = require(path.join(dist, 'db/localDatabase'))
const { LocalCatalogRepository } = require(path.join(dist, 'repositories/catalogRepository'))
const { LocalPosRepository } = require(path.join(dist, 'repositories/posRepository'))
const { LocalWarehouseRepository } = require(path.join(dist, 'repositories/warehouseRepository'))
const root = mkdtempSync(path.join(tmpdir(), 'forsage-writeoff-return-'))
let db
try {
  db = new LocalDatabase(root)
  let pos = new LocalPosRepository(db), warehouse = new LocalWarehouseRepository(db)
  const cashier = randomUUID(), shift = pos.openShift({ cashier_id: cashier, opening_cash: 1000 })
  const product = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: 'TEST-OIL', name: 'Тестова олива', unit: 'л', qty_on_hand: 10, retail_price: 100, purchase_price: 50 }).id
  const sale = pos.checkout({ cashier_id: cashier, shift_id: shift, items: [{ product_id: product, qty: 0.3, unit_price: 100 }], discount: 1, payments: [{ method: 'cash', amount: 29 }] }).sale_id
  const line = pos.getSaleForReturn(sale).items[0]
  assert.equal(line.available_refund, 29)
  const request = { sale_id: sale, approved_by: cashier, shift_id: shift, client_operation_id: randomUUID(), items: [{ sale_item_id: line.id, product_id: product, quantity: 0.1 }] }
  const first = pos.createReturn(request)
  assert.equal(first.refund_kopecks, 10)
  assert.equal(pos.getSaleForReturn(sale).items[0].available_qty, 0.2)
  const writeoff = { operation_id: randomUUID(), user_id: cashier, reason: 'damage', items: [{ product_id: product, qty: 0.3 }] }
  const written = warehouse.createWriteoff(writeoff)
  db.close(); db = new LocalDatabase(root)
  pos = new LocalPosRepository(db); warehouse = new LocalWarehouseRepository(db)
  assert.equal(pos.getReturnByOperation(request.client_operation_id, cashier).id, first.id)
  assert.equal(pos.createReturn(request).id, first.id)
  assert.equal(warehouse.getWriteoffByOperation(writeoff.operation_id, cashier).id, written.id)
  assert.equal(warehouse.createWriteoff(writeoff).id, written.id)
  assert.equal(db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get(product).qty_on_hand, 9.5)
  const final = pos.createReturn({ ...request, client_operation_id: randomUUID(), items: [{ ...request.items[0], quantity: 0.2 }] })
  assert.equal(final.refund_kopecks, 19)
  assert.equal(pos.getSaleForReturn(sale).items[0].available_refund, 0)
  assert.equal(pos.getSale(sale).status, 'returned')
  assert.equal(pos.getExpectedCash(cashier).expected_amount, 1000)
  assert.equal(db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get(product).qty_on_hand, 9.7)
  assert.equal(db.prepare('SELECT count(*) n FROM customer_returns').get().n, 2)
  assert.equal(db.prepare('SELECT count(*) n FROM writeoffs').get().n, 1)
  console.log(JSON.stringify({ success: true, packaged: process.argv.includes('--packaged'), fractionalStock: true, discountedRefund: true, reopenIdempotency: true, readOnlyRecovery: true }))
} finally {
  db?.close()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-writeoff-return-')) rmSync(root, { recursive: true, force: true })
}
