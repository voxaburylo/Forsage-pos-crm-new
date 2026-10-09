// Synthetic local database only; no network, shop database or installed application.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const assert = require('node:assert/strict')
const { LocalDatabase } = require('../dist/db/localDatabase')
const { createBackgroundSyncExecutor } = require('../dist/repositories/syncPullWorker')
const { createSupplierCatalogManifest } = require('../dist/lib/supplierCatalogManifest')
const tenant = '00000000-0000-0000-0000-000000000001'
const at = '2026-10-09T10:00:00.000000Z', later = '2026-10-09T11:00:00.000000Z'
function fixture(cursor = later, since = null) {
  const items = [{ id: 'fixture-price', tenant_id: tenant, sku: 'FILTER', name: 'Filter', qty: '2', price_kopecks: 12000 }]
  const imports = []
  return { tenant_id: tenant, cursor, exported_at: cursor, reset_required: false, reset_generation: 0,
    supplier_price_items: items, supplier_price_imports: imports,
    supplier_catalog_copy: createSupplierCatalogManifest(tenant, cursor, items, imports, since) }
}
async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-incoming-native-'))
  let db, checks = 0
  const check = (a, b) => { assert.deepEqual(a, b); checks++ }
  try {
    db = new LocalDatabase(root)
    const executor = createBackgroundSyncExecutor(db)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)
    const snapshot = () => JSON.stringify(tables.map(name => db.prepare('SELECT * FROM "' + name.replaceAll('"','""') + '" ORDER BY rowid').all()))
    await executor.applyPullChanges(fixture(at))
    check(db.prepare('SELECT qty FROM supplier_price_items').get().qty, 2)
    const before = snapshot()
    for (const kind of ['pull','bootstrap']) {
      for (const fault of ['missing','future','string-version','null','tenant','cursor','reset','generation','generation-missing','row']) {
        const input = fixture()
        if (fault === 'missing') delete input.supplier_catalog_copy
        if (fault === 'future') input.supplier_catalog_copy.version = 2
        if (fault === 'string-version') input.supplier_catalog_copy.version = '1'
        if (fault === 'null') input.supplier_catalog_copy = null
        if (fault === 'tenant') {
          input.tenant_id = 'foreign'; input.supplier_price_items[0].tenant_id = 'foreign'
          input.supplier_catalog_copy = createSupplierCatalogManifest('foreign',later,input.supplier_price_items,[])
        }
        if (fault === 'cursor') { delete input.cursor; delete input.exported_at }
        if (fault === 'reset') input.reset_required = true
        if (fault === 'generation') input.reset_generation = 1
        if (fault === 'generation-missing') delete input.reset_generation
        if (fault === 'row') input.supplier_price_items[0].qty = '99'
        const operation = kind === 'pull' ? executor.applyPullChanges(input) : executor.importSnapshot(input)
        await assert.rejects(operation); checks++
        check(snapshot(), before)
        check(db.prepare('PRAGMA busy_timeout').get().timeout, 5000)
      }
    }
    const gap = fixture(later,'2026-10-09T10:00:00.000001Z')
    await assert.rejects(executor.applyPullChanges(gap), /проміжок/); checks++
    check(snapshot(), before)
    await assert.rejects(executor.importSnapshot(fixture(later,at)), /повною/); checks++
    check(snapshot(), before)
    await assert.rejects(executor.applyPullChanges(fixture('2026-10-09T09:59:59Z')), /старіша/); checks++
    check(snapshot(), before)
    // A contiguous delta and an overlapping retry remain usable.
    await executor.applyPullChanges(fixture(later,at))
    await executor.applyPullChanges(fixture(later,at))
    check(db.prepare('SELECT count(*) n FROM supplier_price_items').get().n, 1)
    check(db.prepare("SELECT pull_cursor FROM sync_state WHERE scope='desktop_server_pull'").get().pull_cursor, later)
    await executor.importSnapshot(fixture(later))
    check(db.prepare('SELECT count(*) n FROM supplier_price_items').get().n, 1)
    check(db.prepare('SELECT count(*) n FROM products').get().n, 0)
    check(db.prepare('SELECT count(*) n FROM sync_outbox').get().n, 0)
    const final = snapshot()
    db.close(); db = new LocalDatabase(root)
    check(snapshot(), final)
    check(Object.values(db.prepare('PRAGMA integrity_check').get())[0], 'ok')
    console.log(JSON.stringify({ ok: true, checks, tablesChecked: tables.length, shopDatabaseOpened: false }))
  } finally {
    await db?.waitForBackgroundWrite().catch(() => {})
    db?.close()
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('forsage-incoming-native-')) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
