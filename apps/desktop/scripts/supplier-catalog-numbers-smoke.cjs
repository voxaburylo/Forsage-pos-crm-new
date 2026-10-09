// Isolated native SQLite/Electron test. No shop data, network or printer access.
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const dist = path.resolve(__dirname, '../dist')
const { LocalDatabase } = require(path.join(dist, 'db/localDatabase'))
const { LocalSupplierCatalogRepository } = require(path.join(dist, 'repositories/supplierCatalogRepository'))
const { catalogQuantity, catalogPriceFromHryvnia } = require(path.join(dist, 'lib/supplierCatalogNumbers'))
const root = mkdtempSync(path.join(tmpdir(), 'forsage-catalog-numbers-native-'))
const tenant = '00000000-0000-0000-0000-000000000001'
const row = (patch = {}) => ({ source_row: 2, sku: 'ITEM', name: 'Fixture item', qty: '0,125', price_kopecks: 123456, ...patch })
let db, repo, checks = 0
const equal = (a, b) => { assert.deepEqual(a, b); checks++ }
const rejects = fn => { assert.throws(fn); checks++ }
try {
  db = new LocalDatabase(root); repo = new LocalSupplierCatalogRepository(db)
  const snapshot = () => JSON.stringify(['supplier_price_items', 'supplier_price_imports', 'sync_outbox', 'products', 'app_meta']
    .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()))
  const initial = repo.create(row())
  equal(initial.qty, '0.125')
  equal(initial.price_kopecks, 123456)
  for (const patch of [
    { qty: '2bad' }, { qty: '0.0001' }, { qty: '1 2' }, { qty: true },
    { price_kopecks: 1.1 }, { price_kopecks: 2147483648 }, { price_kopecks: null },
  ]) {
    const before = snapshot()
    rejects(() => repo.update(initial.id, patch))
    equal(snapshot(), before)
    for (const mode of ['add', 'replace']) {
      rejects(() => repo.importRows('invalid.csv', [row({ sku: 'NEW', name: 'New' }), row(patch)], { mode, supplier_id: null }))
      equal(snapshot(), before)
    }
  }
  for (const mode of ['add', 'replace']) {
    const before = snapshot()
    rejects(() => repo.importRows('partial.csv', [row()], { mode, supplier_id: null, parse_errors: [{ row: 4, error: 'Invalid quantity' }] }))
    equal(snapshot(), before)
  }
  const imported = repo.importRows('valid.csv', [row({ qty: '0.1' }), row({ qty: '0.2' }), row({ qty: '0.001' })],
    { mode: 'replace', supplier_id: null })
  const payload = JSON.parse(db.prepare('SELECT payload_json FROM sync_outbox WHERE aggregate_id=?').get(imported.importId).payload_json)
  equal(payload.items.length, 1)
  equal(payload.items[0].qty, '0.301')
  equal(payload.items[0].price_kopecks, 123456)
  const beforeRestart = snapshot()
  db.close(); db = new LocalDatabase(root); repo = new LocalSupplierCatalogRepository(db)
  equal(snapshot(), beforeRestart)
  equal(repo.list({ tenant_id: tenant }).data[0].qty, '0.301')
  const copied = row({ id: 'remote-native', name: 'Remote', sku: 'REMOTE', qty: '1 234,125' })
  equal(repo.upsertRemoteItem(copied, tenant, '2026-10-08T12:00:00Z'), true)
  equal(repo.list({ query: 'REMOTE' }).data[0].qty, '1234.125')
  const before = snapshot()
  rejects(() => repo.upsertRemoteItem({ ...copied, qty: '3bad' }, tenant, '2026-10-08T13:00:00Z'))
  equal(snapshot(), before)
  equal(db.prepare('SELECT count(*) n FROM products').get().n, 0)
  equal(catalogQuantity('0,125'), '0.125')
  equal(catalogPriceFromHryvnia('1 234,56'), 123456)
  console.log(JSON.stringify({ ok: true, checks, shopDatabaseOpened: false, packagedExeChanged: false }))
} finally {
  db?.close()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-catalog-numbers-native-'))
    rmSync(root, { recursive: true, force: true })
}
