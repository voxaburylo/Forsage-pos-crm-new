// Isolated synthetic database only. No production files, network, UI or printer.
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const compiled = path.resolve(__dirname, process.argv.includes('--packaged') ? '../release/win-unpacked/resources/app.asar/dist' : '../dist')
const { LocalDatabase } = require(path.join(compiled, 'db/localDatabase'))
const { DEFAULT_TENANT_ID } = require(path.join(compiled, 'db/localTypes'))
const { LocalCatalogRepository } = require(path.join(compiled, 'repositories/catalogRepository'))
const { LocalSupplyRepository } = require(path.join(compiled, 'repositories/supplyRepository'))
const { commitReceivingInWorker } = require(path.join(compiled, 'repositories/supplyInvoiceWorker'))
async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'forsage-receiving-worker-'))
  let db
  try {
    db = new LocalDatabase(root); new LocalCatalogRepository(db)
    const supplier = new LocalSupplyRepository(db).saveSupplier({ name: 'Synthetic supplier' }).id
    const ts = new Date().toISOString()
    db.transaction(() => {
      const insert = db.prepare('INSERT INTO products(id,tenant_id,sku,name,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      for (let i = 0; i < 15000; i++) insert.run(`fixture-${i}`, DEFAULT_TENANT_ID, `SKU-${i}`, `Товар ${i}`, ts, ts)
    })
    const input = { operation_id: randomUUID(), invoice_id: randomUUID(), supplier_id: supplier,
      items: Array.from({ length: 100 }, (_, i) => ({ client_key: `row-${i}`, sku: `NEW-${i}`, product_name: `Новий товар ${i}`, qty: 98, purchase_price: 1000, retail_price: 1500 })),
      payments: [{ amount: 9800000, payment_method: 'cash', fund_source: 'owner_funds' }] }
    let ticks = 0, last = performance.now(), maxDelay = 0
    const timer = setInterval(() => { const now = performance.now(); maxDelay = Math.max(maxDelay, now - last); last = now; ticks++ }, 20)
    const start = performance.now()
    let saved
    try { saved = await commitReceivingInWorker(root, input) } finally { clearInterval(timer) }
    assert.equal(saved.status, 'posted'); assert.equal(saved.paid_amount, 9800000); assert.equal(saved.items.length, 100)
    assert(ticks > 0); assert(maxDelay < 2000, 'Worker blocked UI heartbeat: ' + maxDelay)
    const replays = await Promise.all([commitReceivingInWorker(root, input), commitReceivingInWorker(root, input)])
    assert(replays.every(result => result.id === saved.id))
    assert.equal(db.prepare('SELECT count(*) n FROM supply_invoices').get().n, 1)
    assert.equal(db.prepare('SELECT count(*) n FROM supplier_payments').get().n, 1)
    assert.equal(db.prepare('SELECT sum(qty_on_hand) n FROM products').get().n, 9800)
    await assert.rejects(commitReceivingInWorker(root, { ...input, operation_id: randomUUID(), items: [{ ...input.items[0], qty: 1 }] }), /DOCUMENT_CONFLICT/)
    const failed = { ...input, invoice_id: randomUUID(), operation_id: randomUUID(), items: [{ ...input.items[0], sku: 'ROLLBACK', product_name: 'Rollback' }], payments: [{ amount: 1, payment_method: 'cash', fund_source: 'cashbox' }] }
    await assert.rejects(commitReceivingInWorker(root, failed), /кас|змін/)
    assert.equal(db.prepare("SELECT count(*) n FROM products WHERE sku='ROLLBACK'").get().n, 0)
    console.log(JSON.stringify({ success: true, catalog: 15000, rows: 100, elapsed_ms: Math.round(performance.now() - start), heartbeat_max_ms: Math.round(maxDelay), atomic: true, idempotent: true }))
  } finally {
    db?.close()
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-receiving-worker-')) rmSync(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
