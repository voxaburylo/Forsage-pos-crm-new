// Real loopback HTTP + isolated Electron/SQLite. Never accesses the shop database.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const http = require('node:http'), assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { LocalDatabase } = require('../dist/db/localDatabase')
const { LocalSyncRepository } = require('../dist/repositories/syncRepository')
const { createSupplierCatalogManifest } = require('../dist/lib/supplierCatalogManifest')
const tenant = '00000000-0000-0000-0000-000000000001', at = '2026-10-09T10:00:00Z'
async function run() {
  const { streamSyncJson } = await import('../../../server/dist/lib/streamSyncJson.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-catalog-transport-native-'))
  let db, server, fault = false, checks = 0
  const rows = Array.from({ length: 15000 }, (_, i) => ({
    id: 'price-' + i, tenant_id: tenant, sku: 'SKU-' + i, name: 'Фільтр 🛢️ '.repeat(18) + i,
    qty: '0.125', price_kopecks: 12345, created_at: at, updated_at: at, deleted_at: null,
  }))
  const history = [{ id: 'import', tenant_id: tenant, filename: 'fixture.csv', mode: 'replace',
    warehouse_name: null, status: 'completed', total_rows: rows.length, processed_rows: rows.length,
    errors_log: [], created_at: at, updated_at: at }]
  const data = { tenant_id: tenant, cursor: at, supplier_price_items: rows, supplier_price_imports: history,
    supplier_catalog_copy: createSupplierCatalogManifest(tenant, at, rows, history) }
  try {
    db = new LocalDatabase(root)
    const snapshot = () => JSON.stringify(['supplier_price_items', 'supplier_price_imports', 'products',
      'sync_outbox', 'sync_state', 'app_meta'].map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()))
    server = http.createServer(async (_req, res) => {
      try { await streamSyncJson(res, fault ? { ...data, interrupted: BigInt(1) } : data) }
      catch { res.destroy() }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = 'http://127.0.0.1:' + server.address().port
    let downloadsBytes = 0
    const downloadApply = async () => {
      const response = await fetch(url)
      assert.equal(response.headers.get('content-length'), null); checks++
      const body = await response.text()
      downloadsBytes = Buffer.byteLength(body)
      const parsed = JSON.parse(body).data
      return new LocalSyncRepository(db).applyPullChangesChunked(parsed)
    }
    fault = true
    const before = snapshot()
    await assert.rejects(downloadApply); checks++
    assert.equal(snapshot(), before); checks++
    fault = false
    const started = performance.now()
    await downloadApply()
    const elapsedMs = Math.round(performance.now() - started)
    assert.ok(downloadsBytes > 4.5 * 1024 * 1024); checks++
    assert.equal(db.prepare('SELECT count(*) n FROM supplier_price_items').get().n, rows.length); checks++
    assert.equal(db.prepare('SELECT count(*) n FROM supplier_price_imports').get().n, 1); checks++
    assert.equal(db.prepare('SELECT qty FROM supplier_price_items LIMIT 1').get().qty, 0.125); checks++
    assert.equal(db.prepare('SELECT count(*) n FROM products').get().n, 0); checks++
    assert.equal(db.prepare('SELECT count(*) n FROM sync_outbox').get().n, 0); checks++
    const saved = snapshot()
    await downloadApply()
    assert.equal(db.prepare('SELECT count(*) n FROM supplier_price_items').get().n, rows.length); checks++
    // Failed later downloads cannot advance completion or modify already received data.
    fault = true
    const committed = snapshot()
    await assert.rejects(downloadApply); checks++
    assert.equal(snapshot(), committed); checks++
    db.close(); db = new LocalDatabase(root)
    assert.equal(snapshot(), committed); checks++
    assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0], 'ok'); checks++
    assert.ok(saved.length > 0)
    console.log(JSON.stringify({ ok: true, checks, rows: rows.length, downloadsBytes, elapsedMs, shopDatabaseOpened: false }))
  } finally {
    if (server) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
    db?.close()
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir())
      && path.basename(root).startsWith('forsage-catalog-transport-native-')) fs.rmSync(root, { recursive: true, force: true })
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
