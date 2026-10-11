// Normal Electron application runtime; synthetic in-memory SQLite only.
// Never imports application main or LocalDatabase, opens a shop DB, or sends data.
const { app } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { DatabaseSync } = require('node:sqlite')

if (!app?.whenReady) throw new Error('Run with normal Electron, without ELECTRON_RUN_AS_NODE')
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-outbox-producer-'))
for (const name of ['appData', 'userData', 'sessionData', 'crashDumps']) {
  const directory = path.join(profileRoot, name)
  fs.mkdirSync(directory)
  app.setPath(name, directory)
}
process.env.APPDATA = path.join(profileRoot, 'appData')
process.env.LOCALAPPDATA = path.join(profileRoot, 'local')
process.env.PORTABLE_EXECUTABLE_DIR = profileRoot
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')

const compiledArg = process.argv.indexOf('--compiled-dir')
if (compiledArg >= 0 && (!process.argv[compiledArg + 1] || process.argv[compiledArg + 1].startsWith('--'))) {
  throw new Error('Missing --compiled-dir value')
}
const dist = compiledArg >= 0 ? path.resolve(process.argv[compiledArg + 1])
  : path.resolve(__dirname, process.argv.includes('--staged')
    ? '../release/staged/win-unpacked/resources/app.asar/dist' : '../dist')
const deadline = setTimeout(() => { console.error('Synthetic product producer probe timed out'); app.exit(1) }, 60_000)
let checks = 0
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++ }
const ok = (value, message) => { assert.ok(value, message); checks++ }
const elapsed = started => Math.round((performance.now() - started) * 100) / 100

app.whenReady().then(() => {
  const { LOCAL_MIGRATIONS } = require(path.join(dist, 'db/schema.js'))
  const { DEFAULT_TENANT_ID: tenant } = require(path.join(dist, 'db/localTypes.js'))
  const { LocalCatalogRepository } = require(path.join(dist, 'repositories/catalogRepository.js'))
  const { LocalSyncRepository } = require(path.join(dist, 'repositories/syncRepository.js'))

  function fixture() {
    const sqlite = new DatabaseSync(':memory:')
    try {
      sqlite.exec('PRAGMA foreign_keys = ON')
      for (const migration of LOCAL_MIGRATIONS) sqlite.exec(migration.sql)
      let transactionId = 0
      const statements = new Map()
      function transact(work, begin) {
        const savepoint = sqlite.isTransaction ? `producer_smoke_${++transactionId}` : null
        sqlite.exec(savepoint ? `SAVEPOINT ${savepoint}` : begin)
        try {
          const result = work()
          assert.ok(!result || typeof result.then !== 'function', 'SQLite fixture requires synchronous work')
          sqlite.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT')
          return result
        } catch (error) {
          sqlite.exec(savepoint ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : 'ROLLBACK')
          throw error
        }
      }
      const db = {
        deviceId: 'synthetic-producer-device',
        prepare(sql) {
          if (!statements.has(sql)) {
            statements.set(sql, sqlite.prepare(sql))
            if (statements.size > 512) statements.delete(statements.keys().next().value)
          }
          return statements.get(sql)
        },
        exec: sql => sqlite.exec(sql),
        transaction: work => transact(work, 'BEGIN IMMEDIATE'),
        readSnapshot: work => transact(work, 'BEGIN'),
      }
      return { sqlite, db, catalog: new LocalCatalogRepository(db), sync: new LocalSyncRepository(db) }
    } catch (error) { sqlite.close(); throw error }
  }

  const rows = db => db.prepare('SELECT * FROM sync_outbox ORDER BY sequence').all()
  const latest = db => db.prepare('SELECT * FROM sync_outbox ORDER BY sequence DESC LIMIT 1').get()
  const immutable = row => Object.fromEntries([
    'sequence', 'operation_id', 'tenant_id', 'device_id', 'aggregate_type', 'aggregate_id',
    'operation_type', 'payload_json', 'attempts', 'created_at',
  ].map(key => [key, row[key]]))
  const businessSnapshot = db => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name<>'sync_outbox' ORDER BY name")
    .all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()])

  function lateAcknowledgementCase() {
    const { sqlite, db, catalog, sync } = fixture()
    try {
      const seed = { id: 'native-race-product', tenant_id: tenant, sku: 'NATIVE-RACE', name: 'Seed', qty_on_hand: 7, purchase_price: 1000, retail_price: 1500 }
      catalog.upsertProduct(seed)
      equal(rows(db).length, 0, 'Seed upsert must not create a producer operation')
      catalog.saveProduct({ ...seed, name: 'Old ordinary edit', retail_price: 1600, qty_on_hand: 999 })
      const old = latest(db)
      const sent = sync.listPending(100)
      equal(sent.length, 1, 'Capture the old outgoing operation before further local edits')
      equal(sent[0].operation_id, old.operation_id)
      equal(sent[0].sequence, old.sequence)
      equal(sent[0].payload.qty_on_hand, 7, 'Ordinary edit must ignore stale editor stock')

      catalog.saveProduct({ ...seed, name: 'Explicit correction', qty_on_hand: 4, stock_correction: true, retail_price: 1700 })
      const correction = latest(db)
      catalog.saveProduct({ ...seed, name: 'Latest ordinary edit', qty_on_hand: 999, retail_price: 2300 })
      const newest = latest(db)
      ok(old.sequence < correction.sequence && correction.sequence < newest.sequence, 'Every save must append a fresh sequence')
      equal(new Set(rows(db).map(row => row.operation_id)).size, 3, 'Every save must append a fresh identity')
      equal(immutable(rows(db)[0]), immutable(old), 'Old outgoing payload and identity must remain immutable')
      equal(rows(db).map(row => row.status), ['synced', 'pending', 'pending'])
      const businessBefore = businessSnapshot(db)
      const identitiesBefore = rows(db).map(immutable)
      const retiredBefore = rows(db)[0]

      sync.applyPushResults([{ sequence: old.sequence, operation_id: old.operation_id, status: 'failed', error: 'Synthetic late rejection' }])
      equal(rows(db)[0], retiredBefore, 'Late failure must not resurrect a retired operation or increment attempts')
      sync.applyPushResults([{ sequence: old.sequence, operation_id: old.operation_id, status: 'synced' }])
      const acknowledgedBefore = rows(db)[0]
      sync.applyPushResults([{ sequence: old.sequence, operation_id: old.operation_id, status: 'failed', error: 'Synthetic duplicate late rejection' }])
      equal(rows(db)[0], acknowledgedBefore, 'Failure after successful acknowledgement must remain a no-op')
      equal(rows(db).map(immutable), identitiesBefore)
      equal(businessSnapshot(db), businessBefore, 'Late acknowledgements must not rewrite stock, dirty flags, movements, or business history')

      const restartedCatalog = new LocalCatalogRepository(db)
      const restartedSync = new LocalSyncRepository(db)
      const pending = restartedSync.listPending(100)
      equal(pending.map(operation => operation.sequence), [correction.sequence, newest.sequence])
      equal(pending.map(operation => operation.operation_id), [correction.operation_id, newest.operation_id])
      equal(pending[0].payload.stock_correction, true)
      equal(pending[0].payload.qty_on_hand, 4)
      equal(pending[1].payload.name, 'Latest ordinary edit')
      equal(pending[1].payload.retail_price, 2300)
      equal(pending[1].payload.qty_on_hand, 4)
      const product = restartedCatalog.findById(seed.id)
      equal([product.name, product.retail_price, product.qty_on_hand], ['Latest ordinary edit', 2300, 4])
      equal(rows(db).map(immutable), identitiesBefore, 'Restart must preserve saved queue identities and payload bytes')
      equal(businessSnapshot(db), businessBefore, 'Restart must not change business data while newer product work remains')
      return { history: rows(db).length, pending: pending.length, quantity: product.qty_on_hand, lateSuccess: true, lateFailure: true, constructorRestart: true }
    } finally { sqlite.close() }
  }

  function producerBoundaryCase() {
    const { sqlite, db, catalog } = fixture()
    try {
      const seed = { id: 'native-boundary-product', tenant_id: tenant, sku: 'NATIVE-BOUNDARY', name: 'Boundary seed', qty_on_hand: 8, retail_price: 1000 }
      catalog.upsertProduct(seed)
      const at = '2026-01-01T10:00:00.000Z'
      const insert = db.prepare(`INSERT INTO sync_outbox(operation_id,tenant_id,device_id,aggregate_type,aggregate_id,
        operation_type,payload_json,status,attempts,next_attempt_at,created_at,last_error)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      const cases = [
        { status: 'pending', retire: true }, { status: 'failed', retire: true },
        { status: 'sending' }, { status: 'synced' },
        { status: 'pending', payload: '{"stock_correction":true}' },
        { status: 'failed', payload: '{"stock_correction":true}' },
        { status: 'pending', operationType: 'product.deleted' },
        { status: 'failed', operationType: 'product.deleted' },
        { status: 'pending', payload: '{malformed' }, { status: 'failed', payload: '{malformed' },
        { status: 'pending', payload: 'null' }, { status: 'pending', payload: '[]' },
        { status: 'pending', payload: 'true' },
        { status: 'pending', tenantId: 'different-tenant' },
        { status: 'pending', aggregateType: 'inventory' },
        { status: 'pending', aggregateId: 'different-product' },
      ]
      for (const [index, entry] of cases.entries()) {
        insert.run(`boundary-${index}`, entry.tenantId || tenant, db.deviceId, entry.aggregateType || 'product',
          entry.aggregateId || seed.id, entry.operationType || 'product.upsert', entry.payload || '{ "name": "old" }',
          entry.status, index + 1, '2099-01-01T10:00:00.000Z', at, `original-error-${index}`)
      }
      const before = rows(db)
      catalog.saveProduct({ ...seed, name: 'New ordinary edit', qty_on_hand: 999, retail_price: 2000 })
      const after = rows(db)
      equal(after.length, before.length + 1)
      for (const [index, row] of before.entries()) {
        equal(immutable(after[index]), immutable(row), 'Producer must not change prior identities, payload bytes, or attempts')
        if (!cases[index].retire) equal(after[index], row, 'Protected producer candidate must remain byte-for-byte unchanged')
        else {
          ok(typeof after[index].synced_at === 'string', 'Retirement must record its completion time')
          equal({ ...after[index] }, { ...row, status: 'synced', synced_at: after[index].synced_at, next_attempt_at: null, last_error: 'Замінено новішою версією товару' })
        }
      }
      equal(after.at(-1).status, 'pending')
      equal(catalog.findById(seed.id).qty_on_hand, 8)
      return { protectedRows: cases.filter(entry => !entry.retire).length, retiredOrdinaryRows: cases.filter(entry => entry.retire).length }
    } finally { sqlite.close() }
  }

  function producerLoadCase() {
    const { sqlite, db, catalog } = fixture()
    try {
      const products = 1000
      const originals = []
      const phases = []
      let openingMovements
      let saveElapsedMs = 0
      for (let version = 1; version <= 3; version++) {
        const started = performance.now()
        for (let product = 0; product < products; product++) {
          const suffix = String(product).padStart(5, '0')
          catalog.saveProduct({ id: `load-${suffix}`, tenant_id: tenant, sku: `NATIVE-${suffix}`,
            name: `Synthetic product ${suffix} version ${version}`, qty_on_hand: version === 1 ? 7 : 999,
            purchase_price: 1000, retail_price: 1500 + version })
        }
        const elapsedMs = elapsed(started)
        saveElapsedMs += elapsedMs
        phases.push({ version, saves: products, elapsedMs })
        const phaseMovements = db.prepare('SELECT * FROM inventory_movements ORDER BY rowid').all()
        if (version === 1) {
          equal(phaseMovements.length, products, 'Initial saves must create one opening balance per product')
          equal(phaseMovements.filter(row => row.source_type === 'opening_balance' && row.qty_delta === 7 && row.qty_after === 7).length, products)
          openingMovements = phaseMovements
        } else {
          equal(phaseMovements, openingMovements, 'Ordinary edit phases must leave opening balances unchanged')
        }
        const phaseRows = rows(db)
        equal(phaseRows.slice(0, originals.length).map(immutable), originals, 'Later save phases must not rewrite any earlier identity or payload')
        originals.push(...phaseRows.slice(originals.length).map(immutable))
      }
      const history = rows(db)
      const pending = history.filter(row => row.status === 'pending')
      equal(history.length, products * 3)
      equal(pending.length, products)
      equal(new Set(history.map(row => row.operation_id)).size, products * 3)
      equal(history.map(immutable), originals)
      for (const [index, operation] of pending.entries()) {
        const suffix = String(index).padStart(5, '0')
        equal(JSON.parse(operation.payload_json).name, `Synthetic product ${suffix} version 3`)
        equal(JSON.parse(operation.payload_json).retail_price, 1503)
        equal(JSON.parse(operation.payload_json).qty_on_hand, 7)
      }
      equal(db.prepare('SELECT COUNT(*) n FROM products WHERE qty_on_hand = 7').get().n, products)
      equal(db.prepare('SELECT * FROM inventory_movements ORDER BY rowid').all(), openingMovements, 'Ordinary edits must not rewrite stock movements')
      return { products, saves: products * 3, pending: pending.length, history: history.length,
        retired: history.filter(row => row.status === 'synced').length, saveElapsedMs: Math.round(saveElapsedMs * 100) / 100, phases }
    } finally { sqlite.close() }
  }

  const scenario = lateAcknowledgementCase()
  const boundaries = producerBoundaryCase()
  const load = producerLoadCase()
  const buildPath = path.join(dist, 'build-info.json')
  const build = fs.existsSync(buildPath) ? JSON.parse(fs.readFileSync(buildPath, 'utf8')).releaseId : null
  console.log(JSON.stringify({ ok: true, runtime: 'electron-application', build, checks, scenario, boundaries, load,
    shopDatabaseOpened: false, networkRequests: false, printerJobs: false }))
  clearTimeout(deadline)
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })

app.on('quit', () => {
  if (path.dirname(profileRoot) === path.resolve(os.tmpdir())
    && path.basename(profileRoot).startsWith('forsage-outbox-producer-')
    && fs.existsSync(profileRoot) && fs.realpathSync(profileRoot) === profileRoot) {
    try { fs.rmSync(profileRoot, { recursive: true, force: true }) } catch { /* Electron may still hold its private cache on Windows. */ }
  }
})
