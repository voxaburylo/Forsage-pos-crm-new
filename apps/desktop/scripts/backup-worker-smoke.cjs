// Runs against synthetic data under the actual Electron/SQLite runtime.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const { LocalDatabase } = require('../dist/db/localDatabase.js')
const { createVerifiedBackup } = require('../dist/db/verifiedBackup.js')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-backup-runtime-'))
async function main() {
  const db = new LocalDatabase(root)
  try {
    const target = path.join(root, 'checked.db')
    await createVerifiedBackup(db.databasePath, target)
    LocalDatabase.assertBackupIsUsable(target)
    const probe = new DatabaseSync(target)
    probe.exec('DROP TABLE supplier_payments'); probe.close()
    assert.throws(() => LocalDatabase.assertBackupIsUsable(target), /LOCAL_BACKUP_MISSING_TABLE/)
    assert.equal(db.prepare("SELECT COUNT(*) n FROM supplier_payments").get().n, 0)
    await assert.rejects(createVerifiedBackup(db.databasePath, db.databasePath), /LOCAL_BACKUP_SAME_FILE/)
    console.log('PASS: compiled backup worker, verified restore guard, original fixture unchanged')
  } finally {
    await db.waitForBackup().catch(() => {})
    db.close()
    assert.equal(path.dirname(root), os.tmpdir())
    assert(path.basename(root).startsWith('forsage-backup-runtime-'))
    fs.rmSync(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
