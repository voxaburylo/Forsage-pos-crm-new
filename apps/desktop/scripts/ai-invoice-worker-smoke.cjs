// Synthetic database only: never open the shop's live database.
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const dist = path.resolve(__dirname, process.argv.includes('--staged') ? '../release/staged/win-unpacked/resources/app.asar/dist' : process.argv.includes('--packaged') ? '../release/win-unpacked/resources/app.asar/dist' : '../dist')
const { LocalDatabase } = require(path.join(dist, 'db/localDatabase'))
const { DEFAULT_TENANT_ID } = require(path.join(dist, 'db/localTypes'))
const { LocalCatalogRepository } = require(path.join(dist, 'repositories/catalogRepository'))
const { createAiInvoiceInWorker, previewAiInvoiceInWorker } = require(path.join(dist, 'repositories/supplyInvoiceWorker'))
async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'forsage-ai-worker-'))
  let db
  try {
    db = new LocalDatabase(root)
    new LocalCatalogRepository(db)
    const ts = new Date().toISOString()
    db.transaction(() => {
      const insert = db.prepare('INSERT INTO products(id,tenant_id,sku,name,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      for (let i = 0; i < 15_000; i++) insert.run(`fixture-${i}`, DEFAULT_TENANT_ID, `Артикул-${i}`, `Тестовий товар ${i}`, ts, ts)
    })
    const input = { operation_id: 'bulk-worker-test', rows: Array.from({ length: 100 }, (_, i) => ({ sku: `NEW-${i}`, name: `Новий товар ${i}`, qty: 98, purchase_price_uah: 10 })) }
    let ticks = 0, last = performance.now(), maxDelay = 0
    const timer = setInterval(() => { const now = performance.now(); maxDelay = Math.max(maxDelay, now - last); last = now; ticks++ }, 20)
    const start = performance.now()
    let first
    try {
      const preview = await previewAiInvoiceInWorker(root, { rows: input.rows })
      assert.equal(preview.length, 100); assert(preview.every(row => row.status === 'new'))
      assert.equal(db.prepare('SELECT count(*) n FROM products').get().n, 15000)
      assert.equal(db.prepare('SELECT count(*) n FROM supply_invoices').get().n, 0)
      first = await createAiInvoiceInWorker(root, input)
    } finally { clearInterval(timer) }
    const elapsed = Math.round(performance.now() - start)
    assert.equal(first.created, 100); assert.equal(first.invoice.items.length, 100)
    assert(first.invoice.items.every(item => item.qty === 98)); assert(ticks > 0); assert(maxDelay < 2000, `UI heartbeat blocked ${maxDelay} ms`)
    const badPreview = await previewAiInvoiceInWorker(root, { rows: [{ ...input.rows[0], qty: 0, unit: 'кг' }] })
    assert(badPreview[0].validation_errors.some(message => message.includes('кількість')))
    assert(badPreview[0].validation_errors.some(message => message.includes('одиниця')))
    const savedPreview = await previewAiInvoiceInWorker(root, input)
    assert(savedPreview.every(row => row.already_saved && row.validation_errors.length === 0))
    const [replay1, replay2] = await Promise.all([createAiInvoiceInWorker(root, input), createAiInvoiceInWorker(root, input)])
    assert.equal(replay1.invoice.id, first.invoice.id); assert.equal(replay2.invoice.id, first.invoice.id)
    await assert.rejects(createAiInvoiceInWorker(root, { ...input, rows: [{ ...input.rows[0], qty: 2 }] }), /інші дані/)
    await assert.rejects(createAiInvoiceInWorker(root, { operation_id: 'rollback', rows: [{ sku: 'ROLLBACK', name: 'Rollback', qty: 1, purchase_price_uah: 1 }, { name: 'Bad', qty: '', purchase_price_uah: 1 }] }), /кількість/)
    assert.equal(db.prepare('SELECT count(*) n FROM supply_invoices').get().n, 1)
    assert.equal(db.prepare("SELECT count(*) n FROM products WHERE sku='ROLLBACK'").get().n, 0)
    assert.equal(db.prepare("SELECT sum(qty_on_hand) n FROM products").get().n, 0)
    console.log(JSON.stringify({ success: true, catalog: 15000, newRows: 100, elapsed_ms: elapsed, heartbeat_max_ms: Math.round(maxDelay), ticks, idempotent: true, rollback: true }))
  } finally {
    db?.close()
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-ai-worker-')) rmSync(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
