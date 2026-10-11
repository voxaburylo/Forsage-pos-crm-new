// Synthetic queue only. Never starts application main, networking or a shop DB.
const { app } = require('electron')
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { DatabaseSync } = require('node:sqlite')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-outbox-startup-'))
for (const name of ['appData', 'userData', 'sessionData', 'crashDumps']) {
  const directory = path.join(root, name)
  fs.mkdirSync(directory)
  app.setPath(name, directory)
}
process.env.LOCALAPPDATA = path.join(root, 'local')
process.env.APPDATA = path.join(root, 'appData')
process.env.PORTABLE_EXECUTABLE_DIR = root
const explicitDist = process.argv.indexOf('--compiled-dir')
if (explicitDist >= 0 && !process.argv[explicitDist + 1]) throw new Error('Missing compiled directory')
const dist = explicitDist >= 0 ? path.resolve(process.argv[explicitDist + 1]) : path.resolve(__dirname, process.argv.includes('--staged') ? '../release/staged/win-unpacked/resources/app.asar/dist' : '../dist')
const deadline = setTimeout(() => { console.error('Synthetic outbox probe timed out'); app.exit(1) }, 60000)

app.whenReady().then(() => {
  const { LocalSyncRepository } = require(path.join(dist, 'repositories/syncRepository.js'))
  const cases = []
  for (const products of [1000, 5000, 10000]) {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(`CREATE TABLE sync_outbox (
        sequence INTEGER PRIMARY KEY, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
        operation_type TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL,
        operation_id TEXT NOT NULL, attempts INTEGER NOT NULL, synced_at TEXT,
        next_attempt_at TEXT, last_error TEXT
      )`)
      const insert = db.prepare(`INSERT INTO sync_outbox VALUES (?, 'product', ?, 'product.upsert', ?, 'pending', ?, 0, NULL, NULL, NULL)`)
      db.exec('BEGIN')
      for (let product = 0; product < products; product++) {
        const id = `fixture-${String(product).padStart(6, '0')}`
        for (let version = 1; version <= 4; version++) {
          const sequence = product * 4 + version
          insert.run(sequence, id, JSON.stringify({ id, name: 'Synthetic product', qty_on_hand: 7, retail_price: 12000,
            ...(version === 3 ? { stock_correction: true } : {}) }), `fixture-op-${sequence}`)
        }
      }
      db.exec('COMMIT')
      const immutable = () => db.prepare('SELECT sequence,aggregate_type,aggregate_id,operation_type,payload_json,operation_id,attempts FROM sync_outbox ORDER BY sequence').all()
      const before = immutable()
      const repository = Object.create(LocalSyncRepository.prototype)
      repository.db = { prepare: sql => db.prepare(sql), transaction: action => {
        db.exec('BEGIN')
        try { const result = action(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
      } }
      const started = performance.now()
      repository.coalesceSupersededProductOperations()
      const elapsed = performance.now() - started
      assert.deepEqual(immutable(), before)
      const pending = db.prepare("SELECT sequence FROM sync_outbox WHERE status='pending' ORDER BY sequence").all().map(row => row.sequence)
      const expected = []
      for (let product = 0; product < products; product++) expected.push(product * 4 + 3, product * 4 + 4)
      assert.deepEqual(pending, expected, 'Newest edit and explicit stock correction must both survive')
      const after = db.prepare('SELECT * FROM sync_outbox ORDER BY sequence').all()
      repository.coalesceSupersededProductOperations()
      assert.deepEqual(db.prepare('SELECT * FROM sync_outbox ORDER BY sequence').all(), after, 'Repeat must be idempotent')
      cases.push({ products, operations: products * 4, preserved: pending.length, elapsedMs: Math.round(elapsed * 100) / 100 })
    } finally { db.close() }
  }
  const buildInfoPath = path.join(dist, 'build-info.json')
  const build = fs.existsSync(buildInfoPath) ? JSON.parse(fs.readFileSync(buildInfoPath, 'utf8')).releaseId : null
  console.log(JSON.stringify({ runtime: 'electron-application', build, cases }))
  clearTimeout(deadline)
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
app.on('quit', () => {
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('forsage-outbox-startup-') && fs.realpathSync(root) === root) {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* Windows may still hold its isolated cache. */ }
  }
})
