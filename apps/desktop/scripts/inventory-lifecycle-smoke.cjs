// Real compiled/packaged repository, synthetic temporary data only; no shop DB or network.
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path'), assert = require('node:assert/strict')
const compiled = path.resolve(__dirname, process.argv.includes('--packaged') ? '../release/win-unpacked/resources/app.asar/dist' : '../dist')
const { LocalDatabase } = require(path.join(compiled, 'db/localDatabase'))
const { DEFAULT_TENANT_ID: tenant } = require(path.join(compiled, 'db/localTypes'))
const { LocalInventoryRepository } = require(path.join(compiled, 'repositories/inventoryRepository'))
const root = mkdtempSync(path.join(tmpdir(), 'forsage-inventory-lifecycle-'))
let db
try {
  db = new LocalDatabase(root)
  const stamp = new Date().toISOString(), catalogSize = 15000, rowCount = 1000
  db.transaction(() => {
    const insert = db.prepare('INSERT INTO products(id,tenant_id,sku,name,qty_on_hand,retail_price,purchase_price,created_at,updated_at) VALUES (?,?,?,?,12,1000,500,?,?)')
    for (let i = 0; i < catalogSize; i++) insert.run(`p${i}`, tenant, `SKU${i}`, `Товар ${i}`, stamp, stamp)
  })
  let repo = new LocalInventoryRepository(db)
  const session = repo.createSession({ name: 'Synthetic revision' }).id
  repo.startSession(session)
  db.transaction(() => {
    const count = db.prepare('INSERT INTO inventory_items(id,tenant_id,session_id,product_id,expected_stock,counted_stock,was_counted,price_checked,created_at,updated_at) VALUES (?,?,?,?,12,3,1,1,?,?)')
    for (let i = 0; i < rowCount; i++) count.run(`item${i}`, tenant, session, `p${i}`, stamp, stamp)
  })
  const before = repo.getSessionData(session)
  assert.equal(before.items.length, rowCount)
  const start = performance.now()
  const updated = repo.updateProducts(session, { edits: Array.from({ length: rowCount }, (_, i) => ({
    product_id: `p${i}`, values: { retail_price: 1200 }, base: { retail_price: 1000, purchase_price: 500 },
  })) })
  const batchMs = Math.round(performance.now() - start)
  assert.equal(updated.length, rowCount)
  assert.equal(db.prepare('SELECT sum(qty_on_hand) n FROM products').get().n, catalogSize * 12)
  assert.throws(() => repo.complete(session, { expected_revision: before.edit_revision }), /DOCUMENT_CONFLICT/)
  const outbox = db.prepare('SELECT count(*) n FROM sync_outbox').get().n
  assert.throws(() => repo.updateProducts(session, { edits: [
    { product_id: 'p0', values: { retail_price: 1800 }, base: { retail_price: 1200 } },
    { product_id: 'p1', values: { retail_price: 1800 }, base: { retail_price: 999 } },
  ] }), /DOCUMENT_CONFLICT/)
  assert.equal(db.prepare("SELECT retail_price FROM products WHERE id='p0'").get().retail_price, 1200)
  assert.equal(db.prepare('SELECT count(*) n FROM sync_outbox').get().n, outbox)
  const revision = repo.getSessionData(session).edit_revision
  db.close(); db = new LocalDatabase(root); repo = new LocalInventoryRepository(db)
  assert.equal(repo.getSessionData(session).edit_revision, revision)
  assert.equal(repo.complete(session, { expected_revision: revision }).items_updated, rowCount)
  assert.equal(repo.complete(session, { expected_revision: revision }).items_updated, rowCount)
  assert.equal(db.prepare("SELECT count(*) n FROM inventory_movements WHERE source_type='inventory'").get().n, rowCount)
  assert.equal(db.prepare('SELECT sum(qty_on_hand) n FROM products').get().n, catalogSize * 12 - rowCount * 9)
  console.log(JSON.stringify({ success: true, catalog: catalogSize, rows: rowCount, price_batch_ms: batchMs, rollback: true, restart: true, completion_replay: true, packaged: process.argv.includes('--packaged') }))
} finally {
  db?.close()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-inventory-lifecycle-')) rmSync(root, { recursive: true, force: true })
}
