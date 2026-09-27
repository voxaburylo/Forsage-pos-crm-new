// Isolated persistence/replay checks with Electron's SQLite and packaged repository.
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const dist = path.resolve(__dirname, process.argv.includes('--packaged') ? '../release/win-unpacked/resources/app.asar/dist' : '../dist')
const { LocalDatabase } = require(path.join(dist, 'db/localDatabase'))
const { LocalOrderRepository } = require(path.join(dist, 'repositories/orderRepository'))
const root = mkdtempSync(path.join(tmpdir(), 'forsage-order-save-'))
let db
try {
  db = new LocalDatabase(root)
  let repo = new LocalOrderRepository(db)
  const manager = randomUUID(), tenant = '00000000-0000-0000-0000-000000000001'
  const body = { manager_id: manager, tenant_id: tenant, operation_id: randomUUID(), source: 'mobile_draft',
    items: [{ name: 'Фільтр тестовий', qty: 2, sell_price: 10000, buy_price: 7000, source_type: 'supplier' }] }
  const created = repo.saveOrder(body)
  db.close(); db = new LocalDatabase(root); repo = new LocalOrderRepository(db)
  assert.equal(repo.getSaveResult(body.operation_id, manager, tenant).id, created.id)
  assert.equal(repo.saveOrder(body).id, created.id)
  const edit = { ...body, operation_id: randomUUID(), expected_updated_at: created.updated_at,
    items: [{ ...body.items[0], id: created.items[0].id, qty: 98 }] }
  const updated = repo.saveOrder(edit, created.id)
  db.close(); db = new LocalDatabase(root); repo = new LocalOrderRepository(db)
  assert.equal(repo.getSaveResult(edit.operation_id, manager, tenant, created.id).items[0].qty, 98)
  assert.equal(repo.saveOrder(edit, created.id).updated_at, updated.updated_at)
  assert.throws(() => repo.saveOrder({ ...edit, operation_id: randomUUID() }, created.id), /змінено/)
  assert.throws(() => repo.getSaveResult(edit.operation_id, randomUUID(), tenant, created.id), /працівнику/)
  assert.equal(db.prepare('SELECT count(*) n FROM customer_orders').get().n, 1)
  assert.equal(db.prepare('SELECT count(*) n FROM customer_order_items').get().n, 1)
  console.log(JSON.stringify({ success: true, packaged: process.argv.includes('--packaged'), restartAcknowledgment: true, createAndEditReplay: true, staleVersionRejected: true, quantity: 98 }))
} finally {
  db?.close()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-order-save-')) rmSync(root, { recursive: true, force: true })
}
