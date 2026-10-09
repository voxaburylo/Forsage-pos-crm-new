// Synthetic databases only. No network, shop application, live data or printers.
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path'), assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { LocalDatabase } = require('../dist/db/localDatabase')
const { LocalSupplierCatalogRepository } = require('../dist/repositories/supplierCatalogRepository')
const { LocalBootstrapRepository } = require('../dist/repositories/bootstrapRepository')
const { LocalSyncRepository } = require('../dist/repositories/syncRepository')
const tenant = '00000000-0000-0000-0000-000000000001', at = '2026-10-08T10:00:00.000Z', later = '2026-10-08T11:00:00.000Z'
const root = mkdtempSync(path.join(tmpdir(), 'forsage-catalog-copy-native-'))
let db, catalog, checks = 0
const equal = (a, b) => { assert.deepEqual(a, b); checks++ }
const item = (id = 'item', fields = {}) => ({ id, name: 'Fixture', sku: 'SKU', qty: '0.125', price_kopecks: 1200, updated_at: at, ...fields })
const history = (id = 'history', fields = {}) => ({ id, filename: 'price.csv', total_rows: 1, processed_rows: 1, updated_at: at, mode: 'replace', warehouse_name: 'Main', ...fields })
const snapshot = () => JSON.stringify(['supplier_price_items', 'supplier_price_imports', 'sync_outbox', 'products', 'sync_state', 'app_meta']
  .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()))
async function main() {
  try {
    db = new LocalDatabase(root); catalog = new LocalSupplierCatalogRepository(db)
    db.prepare('INSERT INTO products(id,tenant_id,sku,name,qty_on_hand,created_at,updated_at) VALUES(?,?,?,?,7,?,?)')
      .run('stock', tenant, 'STOCK', 'Stock fixture', at, at)
    for (const kind of ['item', 'import']) {
      const table = kind === 'item' ? 'supplier_price_items' : 'supplier_price_imports'
      const apply = fields => kind === 'item' ? catalog.upsertRemoteItem(item('item', fields), tenant, at) : catalog.upsertRemoteImport(history('history', fields), tenant, at)
      for (const op of ['INSERT', 'UPDATE']) {
        if (op === 'UPDATE') apply({})
        const faults = [
          'BEFORE ' + op + ' ON ' + table + ' BEGIN SELECT RAISE(IGNORE); END;',
          'AFTER ' + op + ' ON ' + table + " BEGIN UPDATE products SET qty_on_hand=0 WHERE id='stock'; END;",
          'AFTER ' + op + ' ON ' + table + ' BEGIN UPDATE ' + table + (kind === 'item' ? ' SET qty=999' : ' SET total_rows=999') + ' WHERE id=NEW.id; END;',
        ]
        for (const fault of faults) {
          db.exec('CREATE TRIGGER fault ' + fault)
          const before = snapshot()
          assert.throws(() => apply({ updated_at: later })); checks++
          equal(snapshot(), before)
          db.exec('DROP TRIGGER fault')
        }
      }
      apply({ updated_at: later })
      const before = snapshot()
      equal(apply({}), false)
      equal(snapshot(), before)
      assert.throws(() => apply({ updated_at: later, name: 'Other', filename: 'other.csv' })); checks++
      equal(snapshot(), before)
    }
    for (const route of ['pull', 'bootstrap', 'sync']) {
      const input = { tenant_id: tenant, cursor: later, exported_at: later, supplier_price_items: [item('batch')], supplier_price_imports: [history('batch')] }
      const apply = () => route === 'sync' ? new LocalSyncRepository(db).applyPullChanges(input) : route === 'pull'
        ? new LocalBootstrapRepository(db).applySyncChanges(tenant, input) : new LocalBootstrapRepository(db).importSnapshot(input)
      const faults = [
        'BEFORE INSERT ON supplier_price_imports BEGIN SELECT RAISE(IGNORE); END;',
        "AFTER INSERT ON supplier_price_imports BEGIN UPDATE supplier_price_items SET qty=999 WHERE id='batch'; END;",
      ]
      if (route !== 'pull') faults.push('AFTER ' + (route === 'sync' ? 'UPDATE OF pull_cursor' : 'INSERT')
        + " ON sync_state BEGIN UPDATE supplier_price_items SET qty=999 WHERE id='batch'; END;")
      for (const fault of faults) {
        const before = snapshot()
        db.exec('CREATE TRIGGER fault ' + fault)
        assert.throws(apply); checks++
        equal(snapshot(), before)
        db.exec('DROP TRIGGER fault')
      }
    }
    const sync = new LocalSyncRepository(db)
    sync.applyPullChanges({ cursor: at })
    // Final metadata must commit with the entire catalog on the actual SQLite engine.
    const stableSnapshot = () => {
      const data = JSON.parse(snapshot())
      data[4] = data[4].map(({ last_attempt_at, updated_at, ...state }) => state)
      return data
    }
    for (const route of ['chunked', 'bootstrap-chunked', 'sync', 'bootstrap']) {
      const changes = { tenant_id: tenant, cursor: later, exported_at: later, references_included: true,
        supplier_price_items: Array.from({ length: 26 }, (_, i) => item('atomic-' + i)),
        supplier_price_imports: [history('atomic', { total_rows: 26, processed_rows: 26 })] }
      const apply = () => route === 'chunked' ? sync.applyPullChangesChunked(changes)
        : route === 'bootstrap-chunked' ? sync.importSnapshotChunked(changes)
        : route === 'sync' ? sync.applyPullChanges(changes) : new LocalBootstrapRepository(db).importSnapshot(changes)
      const faults = [
        'BEFORE INSERT ON supplier_price_imports BEGIN SELECT RAISE(IGNORE); END;',
        'BEFORE UPDATE OF pull_cursor ON sync_state BEGIN SELECT RAISE(IGNORE); END;',
        "AFTER UPDATE OF pull_cursor ON sync_state BEGIN UPDATE sync_state SET pull_cursor='wrong' WHERE scope=NEW.scope; END;",
        "AFTER UPDATE OF pull_cursor ON sync_state BEGIN UPDATE products SET qty_on_hand=0 WHERE id='stock'; END;",
        "BEFORE INSERT ON app_meta WHEN NEW.key='desktop_last_reference_sync_at' BEGIN SELECT RAISE(IGNORE); END;",
        "AFTER INSERT ON app_meta WHEN NEW.key='desktop_last_reference_sync_at' BEGIN UPDATE app_meta SET value_json='null' WHERE key=NEW.key; END;",
      ]
      if (route.includes('bootstrap')) faults.push(
        "BEFORE INSERT ON app_meta WHEN NEW.key='last_bootstrap_snapshot' BEGIN SELECT RAISE(IGNORE); END;")
      for (const fault of faults) {
        const before = stableSnapshot()
        db.exec('CREATE TRIGGER fault ' + fault)
        await assert.rejects(async () => apply()); checks++
        equal(stableSnapshot(), before)
        db.exec('DROP TRIGGER fault')
      }
    }
    const input = { cursor: later, supplier_price_items: Array.from({ length: 26 }, (_, i) => item('part-' + i)) }
    db.exec("CREATE TRIGGER fault BEFORE INSERT ON supplier_price_items WHEN NEW.id='part-25' BEGIN SELECT RAISE(IGNORE); END;")
    await assert.rejects(() => sync.applyPullChangesChunked(input)); checks++
    equal(db.prepare("SELECT pull_cursor FROM sync_state WHERE scope='desktop_server_pull'").get().pull_cursor, at)
    equal(db.prepare("SELECT count(*) n FROM supplier_price_items WHERE id LIKE 'part-%'").get().n, 0)
    db.exec('DROP TRIGGER fault')
    await sync.applyPullChangesChunked(input)
    equal(db.prepare("SELECT count(*) n FROM supplier_price_items WHERE id LIKE 'part-%'").get().n, 26)
    equal(db.prepare("SELECT pull_cursor FROM sync_state WHERE scope='desktop_server_pull'").get().pull_cursor, later)
    const saved = snapshot()
    db.close(); db = new LocalDatabase(root)
    equal(snapshot(), saved)
    const copiedRows = Number(process.env.FORSAGE_CATALOG_TEST_ROWS || 2000)
    assert(Number.isSafeInteger(copiedRows) && copiedRows >= 1 && copiedRows <= 50000)
    const start = performance.now()
    await new LocalSyncRepository(db).applyPullChangesChunked({
      cursor: later, supplier_price_items: Array.from({ length: copiedRows }, (_, i) => item('large-' + i)),
      supplier_price_imports: [history('large', { total_rows: copiedRows, processed_rows: copiedRows })],
    })
    const elapsedMs = Math.round(performance.now() - start)
    equal(db.prepare("SELECT count(*) n FROM supplier_price_items WHERE id LIKE 'large-%'").get().n, copiedRows)
    equal(db.prepare('SELECT qty_on_hand FROM products').get().qty_on_hand, 7)
    equal(db.prepare('SELECT count(*) n FROM sync_outbox').get().n, 0)
    equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0], 'ok')
    console.log(JSON.stringify({ ok: true, checks, copiedRows, elapsedMs, shopDatabaseOpened: false }))
  } finally {
    db?.close()
    if (path.dirname(path.resolve(root)) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-catalog-copy-native-'))
      rmSync(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
