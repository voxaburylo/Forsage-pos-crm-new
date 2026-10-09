// Synthetic data only: no shop database, network, UI or print jobs.
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { LocalDatabase } = require('../dist/db/localDatabase')
const { LocalSupplierCatalogRepository } = require('../dist/repositories/supplierCatalogRepository')
const tenant = '00000000-0000-0000-0000-000000000001', at = '2026-10-08T13:00:00Z'
const root = mkdtempSync(path.join(tmpdir(), 'forsage-catalog-write-native-'))
let db, repo, checks = 0
const equal = (a, b) => { assert.deepEqual(a, b); checks++ }
const row = (patch = {}) => ({ source_row: 1, sku: 'NEW', name: 'New fixture', qty: '0.125', price_kopecks: 1234, ...patch })
try {
  db = new LocalDatabase(root); repo = new LocalSupplierCatalogRepository(db)
  db.prepare('INSERT INTO products(id,tenant_id,sku,name,qty_on_hand,created_at,updated_at) VALUES(?,?,?,?,7,?,?)').run('stock', tenant, 'STOCK', 'Stock fixture', at, at)
  const item = repo.create(row({ sku: 'OLD', name: 'Old fixture', qty: 2 }))
  const snapshot = () => JSON.stringify(['supplier_price_items', 'supplier_price_imports', 'sync_outbox', 'products', 'app_meta']
    .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()))
  const act = action => action === 'create' ? repo.create(row())
    : action === 'update' ? repo.update(item.id, row({ sku: 'OLD' }))
    : action === 'delete' ? repo.delete(item.id)
    : repo.importRows('fixture.csv', [row({ sku: action === 'add' ? 'OLD' : 'NEW' })], { mode: action, supplier_id: null })
  for (const action of ['create', 'update', 'delete', 'add', 'replace']) {
    const itemOperation = action === 'create' || action === 'replace' ? 'INSERT' : 'UPDATE'
    const faults = [
      'BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(IGNORE); END;',
      'BEFORE ' + itemOperation + ' ON supplier_price_items BEGIN SELECT RAISE(IGNORE); END;',
      "AFTER INSERT ON sync_outbox BEGIN UPDATE products SET qty_on_hand=0 WHERE id='stock'; END;",
      "AFTER INSERT ON sync_outbox BEGIN UPDATE sync_outbox SET payload_json='{}' WHERE sequence=NEW.sequence; END;",
      "AFTER INSERT ON sync_outbox BEGIN UPDATE supplier_price_items SET price_kopecks=1; END;",
    ]
    for (const fault of faults) {
      const before = snapshot()
      db.exec('CREATE TRIGGER fault ' + fault)
      assert.throws(() => act(action)); checks++
      equal(snapshot(), before)
      db.exec('DROP TRIGGER fault')
    }
  }
  for (const mode of ['add', 'replace']) {
    const before = snapshot()
    db.exec('CREATE TRIGGER fault BEFORE INSERT ON supplier_price_imports BEGIN SELECT RAISE(IGNORE); END;')
    assert.throws(() => act(mode)); checks++
    equal(snapshot(), before)
    db.exec('DROP TRIGGER fault')
  }
  const before = snapshot()
  db.exec("CREATE TRIGGER fault BEFORE UPDATE ON supplier_price_items WHEN NEW.deleted_at IS NOT NULL BEGIN SELECT RAISE(IGNORE); END;")
  assert.throws(() => act('replace')); checks++
  equal(snapshot(), before)
  db.exec('DROP TRIGGER fault')
  for (const mode of ['add', 'replace']) {
    assert.throws(() => repo.importRows('conflict.csv', [
      row({ sku: 'A', barcode: '111', name: 'A' }),
      row({ sku: 'B', barcode: '222', name: 'B' }),
      row({ sku: 'A', barcode: '222', name: 'C' }),
    ], { mode, supplier_id: null })); checks++
    equal(snapshot(), before)
  }
  repo.importRows('valid.csv', [row({ qty: '0.1' }), row({ qty: '0.2' })], { mode: 'replace', supplier_id: null })
  equal(repo.list({}).data[0].qty, '0.3')
  const saved = snapshot()
  db.close(); db = new LocalDatabase(root); repo = new LocalSupplierCatalogRepository(db)
  equal(snapshot(), saved)
  equal(db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get('stock').qty_on_hand, 7)
  // Measure the repeated-row path against a realistically sized synthetic product index.
  db.transaction(() => {
    const insert = db.prepare('INSERT INTO products(id,tenant_id,sku,name,qty_on_hand,created_at,updated_at) VALUES(?,?,?,?,0,?,?)')
    for (let i = 0; i < 15000; i++) insert.run('P' + i, tenant, 'SKU' + i, 'Synthetic product ' + i, at, at)
  })
  repo.importRows('initial.csv', Array.from({ length: 2000 }, (_, i) => row({ sku: 'SKU' + i, name: 'Synthetic product ' + i, qty: 10 })),
    { mode: 'replace', supplier_id: null, warehouse_name: 'Benchmark' })
  const start = performance.now()
  repo.importRows('repeated.csv', Array.from({ length: 1000 }, () => row({ sku: 'SKU0', name: 'Synthetic product 0', qty: '0.001' })),
    { mode: 'add', supplier_id: null, warehouse_name: 'Benchmark' })
  const elapsedMs = Math.round(performance.now() - start)
  equal(db.prepare("SELECT qty FROM supplier_price_items WHERE warehouse_name='Benchmark' AND sku='SKU0'").get().qty, 11)
  equal(db.prepare('SELECT count(*) n FROM products').get().n, 15001)
  console.log(JSON.stringify({ ok: true, checks, repeatedRows: 1000, products: 15000, priceRows: 2000, elapsedMs, shopDatabaseOpened: false }))
} finally {
  db?.close()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-catalog-write-native-'))
    rmSync(root, { recursive: true, force: true })
}
