// Isolated native Electron/SQLite tests. Never opens the shop database.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const assert = require('node:assert/strict'), { performance } = require('node:perf_hooks')
const { Worker } = require('node:worker_threads'), { DatabaseSync } = require('node:sqlite')
const { LocalDatabase } = require('../dist/db/localDatabase')
const { LocalSyncRepository } = require('../dist/repositories/syncRepository')
const { createBackgroundSyncExecutor } = require('../dist/repositories/syncPullWorker')
const { createSupplierCatalogManifest } = require('../dist/lib/supplierCatalogManifest')
const tenant = '00000000-0000-0000-0000-000000000001'
const at = '2026-10-09T10:00:00.000Z', later = '2026-10-09T11:00:00.000Z'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function fixture(n, cursor = at, qty = '0.125') {
  const rows = Array.from({ length: n }, (_, i) => ({
    id: 'price-' + i, tenant_id: tenant, sku: 'SKU-' + i, name: 'Фільтр 🛢️ '.repeat(18) + i,
    qty, price_kopecks: 12345, created_at: at, updated_at: cursor, deleted_at: null,
  }))
  const history = [{ id: 'import', tenant_id: tenant, filename: 'fixture.csv', mode: 'replace',
    warehouse_name: null, status: 'completed', total_rows: n, processed_rows: n,
    errors_log: [], created_at: at, updated_at: cursor }]
  return { tenant_id: tenant, cursor, exported_at: cursor, reset_required: false, reset_generation: 0,
    supplier_price_items: rows, supplier_price_imports: history,
    supplier_catalog_copy: createSupplierCatalogManifest(tenant, cursor, rows, history) }
}
async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-catalog-worker-native-'))
  let db, probe, heartbeat, pending
  let checks = 0, beats = 0, maxGapMs = 0, lastBeat = performance.now()
  const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++ }
  try {
    db = new LocalDatabase(root)
    probe = new DatabaseSync(db.databasePath, { timeout: 0 })
    const executor = createBackgroundSyncExecutor(db)
    const sync = new LocalSyncRepository(db, undefined, executor)
    const cursor = () => db.prepare("SELECT pull_cursor FROM sync_state WHERE scope='desktop_server_pull'").get()?.pull_cursor
    const stable = () => JSON.stringify({ cursor: cursor(), tables: ['supplier_price_items', 'supplier_price_imports',
      'products', 'sync_outbox', 'app_meta'].map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()) })
    const input = fixture(15000)
    const payloadBytes = Buffer.byteLength(JSON.stringify(input))
    heartbeat = setInterval(() => {
      const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - lastBeat); lastBeat = now; beats++
    }, 10)
    lastBeat = performance.now()
    const started = performance.now()
    pending = sync.applyPullChangesChunked(input)
    assert.throws(() => db.close(), /Копіювання ще триває/); checks++
    await assert.rejects(sync.applyPullChangesChunked(input), /Копіювання вже триває/); checks++
    // The Worker has already cloned the payload, including identifiers and catalog rows.
    input.cursor = 'mutated'; input.supplier_price_items[0].qty = '999'
    const result = await pending; pending = undefined
    const elapsedMs = Math.round(performance.now() - started)
    clearInterval(heartbeat); heartbeat = undefined
    check(result.cursor, at)
    check(db.prepare('SELECT count(*) n FROM supplier_price_items').get().n, 15000)
    check(db.prepare('SELECT qty FROM supplier_price_items LIMIT 1').get().qty, 0.125)
    check(db.prepare('SELECT count(*) n FROM supplier_price_imports').get().n, 1)
    check(db.prepare('SELECT count(*) n FROM products').get().n, 0)
    check(db.prepare('SELECT count(*) n FROM sync_outbox').get().n, 0)
    check(db.prepare('PRAGMA busy_timeout').get().timeout, 5000)
    assert.ok(beats >= 20, 'heartbeat remains active during copy'); checks++
    assert.ok(maxGapMs < 1000, 'no second-long event-loop stall: ' + maxGapMs); checks++

    await executor.applyPullChanges(fixture(15000))
    check(db.prepare('SELECT count(*) n FROM supplier_price_items').get().n, 15000)
    for (const fault of ['row', 'history', 'completion']) {
      const before = stable()
      const sql = fault === 'row'
        ? "BEFORE INSERT ON supplier_price_items WHEN NEW.id='price-14999'"
        : fault === 'history' ? 'BEFORE INSERT ON supplier_price_imports' : 'BEFORE UPDATE OF pull_cursor ON sync_state'
      db.exec('CREATE TRIGGER fixture_fault ' + sql + " BEGIN SELECT RAISE(ABORT, 'fixture abort'); END")
      await assert.rejects(executor.applyPullChanges(fixture(15000, later, '2')), /fixture abort/); checks++
      check(stable(), before)
      db.exec('DROP TRIGGER fixture_fault')
    }
    // A broken manifest must not change even attempt metadata.
    const invalid = fixture(10, later); invalid.supplier_price_items.pop()
    const fullBefore = stable() + JSON.stringify(db.prepare('SELECT * FROM sync_state').all())
    await assert.rejects(executor.applyPullChanges(invalid)); checks++
    check(stable() + JSON.stringify(db.prepare('SELECT * FROM sync_state').all()), fullBefore)

    // Kill an actual worker only after its final transaction holds the SQLite writer lock.
    let worker
    const crashExecutor = createBackgroundSyncExecutor(db, { workerFactory: (file, options) => {
      worker = new Worker(file, options); return worker
    } })
    const beforeCrash = stable()
    const previousAttempt = db.prepare('SELECT last_attempt_at FROM sync_state').get().last_attempt_at
    pending = crashExecutor.applyPullChanges(fixture(30000, later, '3'))
    const settled = pending.then(value => ({ value }), error => ({ error }))
    let locked = false
    const deadline = performance.now() + 15000
    while (performance.now() < deadline) {
      const changed = db.prepare('SELECT last_attempt_at FROM sync_state').get().last_attempt_at !== previousAttempt
      try { probe.exec('BEGIN IMMEDIATE'); probe.exec('ROLLBACK') }
      catch (error) {
        if (!/locked|busy/i.test(error.message)) throw error
        if (changed) { locked = true; break }
      }
      await sleep(2)
    }
    assert.ok(locked, 'observed worker transaction'); checks++
    check(cursor(), at)
    check(db.prepare('SELECT qty FROM supplier_price_items LIMIT 1').get().qty, 0.125)
    const busyStarted = performance.now()
    assert.throws(() => db.transaction(() => db.prepare("UPDATE supplier_price_items SET qty=9 WHERE id='price-0'").run()), /locked|busy/i); checks++
    const busyMs = performance.now() - busyStarted
    assert.ok(busyMs < 250, 'competing write fails promptly: ' + busyMs); checks++
    await worker.terminate()
    const outcome = await settled; pending = undefined
    assert.ok(outcome.error, 'worker termination must not report success'); checks++
    check(stable(), beforeCrash)
    check(db.prepare('PRAGMA busy_timeout').get().timeout, 5000)

    // Retry after interruption is safe and also exercises the bootstrap worker route.
    const bootstrap = fixture(15000, later, '2')
    const imported = await sync.importSnapshotChunked(bootstrap)
    check(imported.tenant_id, tenant)
    check(cursor(), later)
    check(db.prepare('SELECT qty FROM supplier_price_items LIMIT 1').get().qty, 2)
    check(db.prepare('SELECT count(*) n FROM supplier_price_imports').get().n, 1)
    await db.waitForBackgroundWrite()
    const committed = stable()
    probe.close(); probe = undefined
    db.close(); db = new LocalDatabase(root)
    check(stable(), committed)
    check(Object.values(db.prepare('PRAGMA integrity_check').get())[0], 'ok')
    console.log(JSON.stringify({ ok: true, checks, rows: 15000, payloadBytes, elapsedMs,
      beats, maxGapMs: Math.round(maxGapMs), competingWriteMs: Math.round(busyMs), shopDatabaseOpened: false }))
  } finally {
    clearInterval(heartbeat)
    if (pending) await pending.catch(() => {})
    probe?.close()
    await db?.waitForBackgroundWrite().catch(() => {})
    db?.close()
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir())
      && path.basename(root).startsWith('forsage-catalog-worker-native-')) fs.rmSync(root, { recursive: true, force: true })
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
