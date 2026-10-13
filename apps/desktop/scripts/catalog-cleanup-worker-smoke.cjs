// Synthetic database only. No caller-supplied data root, application main, network or AI.
const { createHash, randomUUID } = require('node:crypto')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

const dist = path.resolve(__dirname, process.argv.includes('--staged') ? '../release/staged/win-unpacked/resources/app.asar/dist' : process.argv.includes('--packaged') ? '../release/win-unpacked/resources/app.asar/dist' : '../dist')
const { LocalDatabase } = require(path.join(dist, 'db/localDatabase'))
const { DEFAULT_TENANT_ID: tenant } = require(path.join(dist, 'db/localTypes'))
const { LocalCatalogRepository } = require(path.join(dist, 'repositories/catalogRepository'))
const { LocalSupplyRepository } = require(path.join(dist, 'repositories/supplyRepository'))
const { LocalPosRepository } = require(path.join(dist, 'repositories/posRepository'))
const { CatalogCleanupRepository } = require(path.join(dist, 'repositories/catalogCleanupRepository'))
const { scanCatalogCleanup } = require(path.join(dist, 'repositories/catalogCleanupWorker'))

const quote = value => '"' + value.replace(/"/g, '""') + '"'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// Compare logical contents, not WAL/SHM bytes that SQLite may touch while opening a reader.
function snapshot(db) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
  const tables = schema.filter(row => row.type === 'table').map(row => {
    const values = db.prepare('SELECT * FROM ' + quote(row.name) + ' ORDER BY rowid').all()
    return { name: row.name, rows: values.length, sha256: digest(values) }
  })
  return { schema: digest(schema), tables }
}

async function main() {
  const tempParent = path.resolve(tmpdir())
  const root = mkdtempSync(path.join(tempParent, 'forsage-catalog-cleanup-worker-'))
  let db
  try {
    db = new LocalDatabase(root)
    const catalog = new LocalCatalogRepository(db), supply = new LocalSupplyRepository(db), pos = new LocalPosRepository(db)
    const owner = randomUUID(), target = randomUUID(), source = randomUUID(), brand = randomUUID()
    const ts = new Date().toISOString(), sourceSku = 'AUTO-106030', targetSku = 'AUTO-88897'
    const sourceName = 'груша подкачки Balaton 10 мм Г-образная'
    const targetName = 'Груша підкачки Balaton10мм Г-образна'
    const primaryCode = '2000000000002', alternateCode = 'SYNTHETIC-BALATON-EXTRA'
    db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,is_active,created_at,updated_at) VALUES(?,?,?,?,1,?,?)')
      .run(owner, tenant, 'Synthetic owner', 'owner', ts, ts)
    db.prepare('INSERT INTO brands(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(brand, tenant, 'Balaton', ts, ts)
    catalog.upsertProduct({ id: target, sku: targetSku, name: targetName, brand_id: brand, barcode: '4820000000001', qty_on_hand: 2, purchase_price: 10000, retail_price: 15000 })
    catalog.upsertProduct({ id: source, sku: sourceSku, name: sourceName, barcode: primaryCode, additional_barcodes: [alternateCode], qty_on_hand: 3,
      purchase_price: 11000, retail_price: 16000, photo_url: 'file:///synthetic/source-photo.jpg', notes: 'Synthetic source provenance' })
    const supplier = supply.saveSupplier({ name: 'Synthetic supplier' })
    const invoice = supply.createInvoice({ supplier_id: supplier.id, items: [{ product_id: source, qty: 1, purchase_price: 11000 }], paid_amount: 0 })
    supply.postInvoice(invoice.id)
    // A closed historical receipt fixture, not a new sale or payment.
    const sale = randomUUID(), saleLine = randomUUID(), shift = pos.openShift({ cashier_id: owner })
    db.prepare("INSERT INTO sales(id,tenant_id,sale_number,cashier_id,shift_id,status,total,payment_method,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,'completed',16000,'cash',?,?,?)")
      .run(sale, tenant, 'SYNTHETIC-OLD-1', owner, shift, ts, ts, ts)
    db.prepare('INSERT INTO sale_items(id,tenant_id,sale_id,product_id,description,sku,qty,unit_price,total,created_at,updated_at) VALUES(?,?,?,?,?,?,1,16000,16000,?,?)')
      .run(saleLine, tenant, sale, source, sourceName, sourceSku, ts, ts)
    db.transaction(() => {
      const insert = db.prepare('INSERT INTO products(id,tenant_id,sku,name,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      for (let index = 0; index < 15_000; index++) insert.run(randomUUID(), tenant, `FIXTURE-${index}`, `Синтетична позиція ${index}`, ts, ts)
    })

    const beforeScan = snapshot(db)
    let ticks = 0, last = performance.now(), maxDelay = 0, analysis
    const start = performance.now()
    const timer = setInterval(() => { const now = performance.now(); maxDelay = Math.max(maxDelay, now - last); last = now; ticks++ }, 20)
    try { analysis = await scanCatalogCleanup(root, tenant) } finally { clearInterval(timer) }
    const elapsed = Math.round(performance.now() - start)
    assert.deepEqual(snapshot(db), beforeScan, 'Read-only worker changed synthetic database contents')
    assert.equal(analysis.stats.products, 15002)
    const group = analysis.groups.find(item => item.product_ids.includes(target) && item.product_ids.includes(source))
    assert(group, 'Compiled worker did not match the Ukrainian/Russian Balaton pair')
    assert.equal(group.level, 'exact'); assert.deepEqual(group.conflicts, [])
    assert(ticks > 0, 'Worker scan did not yield an event-loop heartbeat')
    assert(maxDelay < 2000, `Worker scan blocked the event loop for ${maxDelay} ms`)

    const row = id => db.prepare('SELECT * FROM products WHERE id=?').get(id)
    const rows = table => db.prepare('SELECT * FROM ' + quote(table) + ' ORDER BY rowid').all()
    const historicalTables = ['sales', 'sale_items', 'supply_invoices', 'supply_invoice_items', 'supplier_payments', 'inventory_movements']
    const historical = historicalTables.map(table => [table, rows(table)])
    // Capability/cart callbacks are deliberately synthetic; no production service is contacted.
    const cleanup = new CatalogCleanupRepository(db, { canMirrorMerge: () => true, externalBlockers: () => [] })
    const selection = { tenant_id: tenant, target_id: target, source_ids: [source], stock_review: 'pending' }
    const preview = cleanup.preview(selection)
    assert.equal(preview.can_apply, true, preview.blockers.join('\n'))
    assert.equal(preview.quantity_after, 6)
    const input = { ...selection, operation_id: randomUUID(), preview_fingerprint: preview.fingerprint, reason: 'Synthetic reviewed duplicate; physical inventory remains pending' }
    const result = cleanup.apply(input, owner)
    assert.equal(result.quantity_after, 6); assert.equal(result.stock_review, 'pending')
    assert.equal(row(target).qty_on_hand, 6); assert.equal(row(source).qty_on_hand, 0)
    assert.equal(row(source).is_active, 0); assert(row(source).deleted_at)
    assert.equal(row(target).purchase_price, 10000); assert.equal(row(target).retail_price, 15000)
    assert.equal(row(target).sku, targetSku); assert.equal(row(target).name, targetName)
    const sourceSpecs = JSON.parse(row(source).specs_json), targetSpecs = JSON.parse(row(target).specs_json)
    assert.equal(sourceSpecs.merged_into_product_id, target)
    assert(sourceSpecs.cleanup_barcodes.includes(primaryCode)); assert(sourceSpecs.cleanup_barcodes.includes(alternateCode))
    assert(targetSpecs.cleanup_sources.some(item => item.id === source && item.sku === sourceSku && item.name === sourceName
      && item.photo_url === 'file:///synthetic/source-photo.jpg' && item.notes === 'Synthetic source provenance'))
    for (const [table, oldRows] of historical) {
      const current = rows(table).filter(item => table !== 'inventory_movements' || item.source_type !== 'product_merge')
      assert.deepEqual(current, oldRows, `Closed history changed: ${table}`)
    }
    const transfer = rows('inventory_movements').filter(item => item.source_type === 'product_merge')
    assert.equal(transfer.length, 2); assert.equal(transfer.reduce((sum, item) => sum + item.qty_delta, 0), 0)
    for (const code of [primaryCode, alternateCode]) {
      assert.equal(catalog.findByBarcode(code)?.id, target)
      for (const filter of [{ product_barcode: code }, { product_search: code }, { search: code }])
        assert.deepEqual(pos.listSales(filter).data.map(item => item.id), [sale], 'Historical label lookup was lost')
    }
    assert.equal(catalog.findBySku('AUTO106030')?.id, target)
    assert(catalog.listProducts({ query: sourceName.toUpperCase() }).data.some(item => item.id === target))
    const mirrorRows = db.prepare("SELECT payload_json FROM sync_outbox WHERE operation_type='product.catalog_cleanup'").all()
    assert.equal(mirrorRows.length, 1)
    const payload = JSON.parse(mirrorRows[0].payload_json)
    assert.equal(payload.products.find(item => item.id === source).specs.merged_into_product_id, target)
    assert.equal(payload.products.find(item => item.id === source).qty_on_hand, 0)
    const afterMerge = snapshot(db)
    assert.deepEqual(cleanup.apply(input, owner), result)
    assert.deepEqual(snapshot(db), afterMerge, 'Replaying the merge wrote data twice')

    console.log(JSON.stringify({ success: true, synthetic: true, catalog: analysis.stats.products,
      worker: true, scan_unchanged: true, balaton_ua_ru: group.level, elapsed_ms: elapsed,
      heartbeat_max_ms: Math.round(maxDelay), ticks, merge: true, stock_conserved: 6,
      immutable_history: true, historical_barcodes: true, names_skus_photos_preserved: true,
      idempotent: true, native_sqlite: process.versions.sqlite, electron: process.versions.electron ?? null }))
  } finally {
    db?.close()
    if (path.dirname(root) === tempParent && path.basename(root).startsWith('forsage-catalog-cleanup-worker-'))
      rmSync(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
