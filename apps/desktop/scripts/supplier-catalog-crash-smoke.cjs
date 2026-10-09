// Terminates only its own child on a synthetic temp database, never the shop app.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { LocalDatabase } = require('../dist/db/localDatabase')
const { LocalSupplierCatalogRepository } = require('../dist/repositories/supplierCatalogRepository')
const { LocalSyncRepository } = require('../dist/repositories/syncRepository')
const tenant = '00000000-0000-0000-0000-000000000001'
const safeRoot = root => path.dirname(path.resolve(root)) === path.resolve(os.tmpdir())
  && path.basename(root).startsWith('forsage-catalog-crash-')
const input = { source_row: 1, sku: 'NEW', name: 'New fixture', qty: '0.125', price_kopecks: 1234 }
const snapshot = db => Object.fromEntries(['supplier_price_items', 'supplier_price_imports', 'sync_outbox', 'products', 'suppliers', 'app_meta', 'sync_state']
  .map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all().map(row => ({ ...row }))]))
function execute(db, spec, sync) {
  const repo = new LocalSupplierCatalogRepository(db)
  if (spec.action.startsWith('remote')) {
    const chunked = spec.action === 'remote-chunked', count = chunked ? 26 : 1
    const changes = {
      cursor: '2026-10-08T10:00:00Z',
      supplier_price_items: Array.from({ length: count }, (_, i) => ({
        ...input, id: i ? 'remote-item-' + i : 'remote-item', updated_at: '2026-10-08T10:00:00Z',
      })),
      supplier_price_imports: [{ id: 'remote-import', filename: 'remote.csv', total_rows: count, processed_rows: count,
        updated_at: '2026-10-08T10:00:00Z', mode: 'replace', warehouse_name: null }],
    }
    const repository = sync ?? new LocalSyncRepository(db)
    return chunked ? repository.applyPullChangesChunked(changes) : repository.applyPullChanges(changes)
  }
  if (spec.action === 'create') return repo.create(input)
  if (spec.action === 'update') return repo.update(spec.itemId, { ...input, sku: 'OLD' })
  if (spec.action === 'delete') return repo.delete(spec.itemId)
  return repo.importRows('crash.csv', [{ ...input, sku: spec.action === 'add' ? 'OLD' : 'NEW' }],
    { supplier_id: null, mode: spec.action, ...(spec.identified ? { operation_id: 'crash-import', user_id: 'cashier' } : {}) })
}
async function worker() {
  const root = path.resolve(process.argv[3]); assert(safeRoot(root))
  const spec = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'))
  const db = new LocalDatabase(root), transaction = db.transaction.bind(db)
  // Constructor maintenance is not the copy COMMIT under test.
  const sync = spec.action.startsWith('remote') ? new LocalSyncRepository(db) : null
  const checkpoint = () => {
    fs.writeFileSync(path.join(root, 'checkpoint'), spec.phase)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000)
    throw Error('Parent did not terminate the fixture child')
  }
  let depth = 0
  db.transaction = fn => {
    const outermost = depth++ === 0
    try {
      const result = transaction(() => {
        const value = fn()
        if (outermost && spec.phase === 'before') checkpoint()
        return value
      })
      if (outermost && spec.phase === 'after') checkpoint()
      return result
    } finally { depth-- }
  }
  await execute(db, spec, sync)
  throw Error('Transaction checkpoint not reached')
}
async function scenario(action, phase, identified = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-catalog-crash-'))
  let db, child, exited = false, exitPromise, stderr = ''
  try {
    db = new LocalDatabase(root)
    const repo = new LocalSupplierCatalogRepository(db)
    const item = repo.create({ ...input, sku: 'OLD', name: 'Old fixture', qty: 2 })
    const before = snapshot(db)
    const spec = { action, phase, itemId: item.id, identified }
    fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify(spec))
    db.close(); db = null
    child = spawn(process.execPath, [__filename, '--worker', root], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    exitPromise = once(child, 'exit').then(() => { exited = true })
    const deadline = Date.now() + 20000
    while (!fs.existsSync(path.join(root, 'checkpoint'))) {
      if (exited || Date.now() > deadline) throw Error('Child failed to reach checkpoint: ' + stderr)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    child.kill()
    await exitPromise
    db = new LocalDatabase(root)
    if (phase === 'before') {
      const rolledBack = snapshot(db)
      if (action === 'remote-chunked') {
        // The attempt timestamp is deliberately recorded before the data transaction.
        for (const key of Object.keys(before).filter(key => key !== 'sync_state'))
          assert.deepEqual(rolledBack[key], before[key])
        assert.equal(rolledBack.sync_state.find(row => row.scope === 'desktop_server_pull')?.pull_cursor ?? null,
          before.sync_state.find(row => row.scope === 'desktop_server_pull')?.pull_cursor ?? null)
      } else assert.deepEqual(rolledBack, before)
      await execute(db, spec) // A confirmed rollback can be retried.
    }
    if (identified) {
      const saved = snapshot(db)
      const result = await execute(db, spec) // Replay the same ID after possible COMMIT/restart.
      assert.deepEqual(snapshot(db), saved)
      assert.deepEqual(new LocalSupplierCatalogRepository(db).resolveImport('crash-import', 'cashier', tenant),
        { status: 'committed', result })
    }
    if (action.startsWith('remote')) {
      const saved = snapshot(db)
      await execute(db, spec)
      const replay = snapshot(db)
      for (const key of ['supplier_price_items', 'supplier_price_imports', 'sync_outbox', 'products', 'suppliers', 'app_meta'])
        assert.deepEqual(replay[key], saved[key])
      assert.deepEqual(replay.products, before.products)
      assert.deepEqual(replay.sync_outbox, before.sync_outbox)
      assert.equal(replay.supplier_price_items.length, before.supplier_price_items.length + (action === 'remote-chunked' ? 26 : 1))
      assert.equal(replay.supplier_price_imports.length, 1)
      assert.equal(replay.supplier_price_items.find(row => row.id === 'remote-item').qty, 0.125)
      assert.equal(replay.sync_state.find(row => row.scope === 'desktop_server_pull').pull_cursor, '2026-10-08T10:00:00Z')
      assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0], 'ok')
      return
    }
    // Legacy internal calls without identity are only inspected, never auto-replayed.
    const after = snapshot(db)
    assert.deepEqual(after.products, before.products)
    assert.deepEqual(after.suppliers, before.suppliers)
    const receiptKey = 'mutation:supplier-import:' + tenant + ':cashier:crash-import'
    assert.deepEqual(after.app_meta.filter(row => row.key !== receiptKey), before.app_meta)
    assert.equal(after.app_meta.length - before.app_meta.length, identified ? 1 : 0)
    assert.equal(after.sync_outbox.length, before.sync_outbox.length + 1)
    const active = after.supplier_price_items.filter(row => !row.deleted_at)
    const expected = { create: [2, 0.125], update: [1, 0.125], delete: [0, null], add: [1, 2.125], replace: [1, 0.125] }[action]
    assert.equal(active.length, expected[0])
    if (expected[1] != null) assert(active.some(row => row.qty === expected[1]))
    const imports = after.supplier_price_imports
    assert.equal(imports.length, ['add', 'replace'].includes(action) ? 1 : 0)
    if (imports.length) {
      assert.equal(imports[0].total_rows, 1)
      assert.equal(imports[0].processed_rows, 1)
      const payload = JSON.parse(after.sync_outbox.at(-1).payload_json)
      assert.equal(payload.import.id, imports[0].id)
      assert.equal(payload.items[0].qty, String(expected[1]))
    }
    const integrity = db.prepare('PRAGMA integrity_check').get()
    assert.equal(Object.values(integrity)[0], 'ok')
  } finally {
    if (child && !exited) { child.kill(); await exitPromise }
    db?.close()
    if (safeRoot(root)) fs.rmSync(root, { recursive: true, force: true })
  }
}
async function main() {
  let scenarios = 0
  for (const action of ['create', 'update', 'delete', 'add', 'replace'])
    for (const phase of ['before', 'after']) { await scenario(action, phase); scenarios++ }
  for (const action of ['add', 'replace'])
    for (const phase of ['before', 'after']) { await scenario(action, phase, true); scenarios++ }
  for (const action of ['remote', 'remote-chunked'])
    for (const phase of ['before', 'after']) { await scenario(action, phase); scenarios++ }
  console.log(JSON.stringify({ ok: true, scenarios, identifiedImportScenarios: 4, remoteCopyScenarios: 4, shopDatabaseOpened: false }))
}
(process.argv[2] === '--worker' ? worker() : main())
  .catch(error => { console.error(error); process.exitCode = 1 })
