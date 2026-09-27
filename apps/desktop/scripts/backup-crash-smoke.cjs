// Actual Electron SQLite/worker, disposable database only; no network or production paths.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { LocalDatabase } = require('../dist/db/localDatabase.js')
if (process.argv[2] === '--child') {
  const root = path.resolve(process.argv[3])
  assert(path.basename(root).startsWith('forsage-backup-crash-'))
  const db = new LocalDatabase(root)
  db.exec('UPDATE crash_probe SET value=98')
  const rename = fs.renameSync
  fs.renameSync = function(from, to) {
    if (path.dirname(from) === db.backupsPath && from.endsWith('.partial')) process.exit(74)
    return rename(from, to)
  }
  db.backupNow().then(() => { throw Error('Fault injection did not stop the child') }).catch(error => { console.error(error); process.exitCode = 1 })
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-backup-crash-'))
  let db
  async function main() {
    try {
      db = new LocalDatabase(root)
      db.exec('CREATE TABLE crash_probe(value INTEGER); INSERT INTO crash_probe VALUES(46)')
      const good = await db.backupNow(), deviceId = db.deviceId
      db.close(); db = undefined
      const result = spawnSync(process.execPath, [__filename, '--child', root], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 30000,
      })
      assert.equal(result.status, 74, result.error?.message || result.stderr)
      const opened = LocalDatabase.open(root); db = opened.database
      assert.equal(opened.recovery, null)
      assert.equal(db.deviceId, deviceId)
      assert.equal(db.prepare('SELECT value FROM crash_probe').get().value, 98, 'Never restore an older backup over committed WAL data')
      assert.deepEqual(db.listBackups().map(row => row.filePath), [good])
      LocalDatabase.assertBackupIsUsable(good)
      const partials = fs.readdirSync(db.backupsPath).filter(name => name.endsWith('.partial'))
      assert.equal(partials.length, 1, 'Interrupted partial is not presented as a ready backup')
      const next = await db.backupNow()
      LocalDatabase.assertBackupIsUsable(next)
      assert.equal(db.listBackups().length, 2)
      assert.equal(db.prepare('SELECT value FROM crash_probe').get().value, 98)
      console.log('PASS: abruptly interrupted backup, old verified backup intact, partial hidden, latest WAL rows preserved, next backup succeeds')
    } finally {
      await db?.waitForBackup().catch(() => {})
      db?.close()
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
      assert(path.basename(root).startsWith('forsage-backup-crash-'))
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
  main().catch(error => { console.error(error); process.exitCode = 1 })
}
