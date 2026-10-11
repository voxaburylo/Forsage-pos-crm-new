// Restore an explicitly selected standalone backup in a disposable environment.
// No Electron main, sync service, network, print, or production DB is started.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')

function fileHash(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
function quoted(name) { return '"' + name.replaceAll('"', '""') + '"' }
function valueHash(value) {
  if (typeof value === 'bigint') return ['integer', value.toString()]
  if (value instanceof Uint8Array) return ['blob', createHash('sha256').update(value).digest('hex')]
  return [typeof value, value]
}
function restoreComparisonOptions(db, sourceVersion, targetVersion) {
  assert(Number.isInteger(sourceVersion) && sourceVersion >= 1 && Number.isInteger(targetVersion)
    && targetVersion >= sourceVersion, 'Invalid restore schema versions')
  assert.equal(Number(db.prepare('SELECT MAX(version) version FROM schema_migrations').get().version),
    targetVersion, 'Restored schema version differs')
  if (sourceVersion === targetVersion) return {}
  // Only explicitly reviewed, additive migrations may change the comparison.
  // Never ignore arbitrary new columns, changed business values or future migrations.
  const omittedColumns = {}
  for (let version = sourceVersion + 1; version <= targetVersion; version += 1) {
    if (version === 27) {
      const columns = db.prepare('PRAGMA table_info(customer_returns)').all()
      assert(columns.some(column => column.name === 'shift_id' && column.type === 'TEXT'),
        'Refund shift column is missing after migration')
      assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM customer_returns WHERE shift_id IS NOT NULL').get().count),
        0, 'Historical refund shifts must remain NULL')
      omittedColumns.customer_returns = ['shift_id']
    } else if (version === 28) {
      const columns = db.prepare('PRAGMA table_info(supplier_price_imports)').all()
      assert(columns.some(column => column.name === 'scope_known' && column.type === 'INTEGER'),
        'Import scope provenance column is missing after migration')
      assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM supplier_price_imports WHERE scope_known IS NOT CASE WHEN remote_updated_at IS NULL THEN 1 ELSE 0 END').get().count),
        0, 'Historical import scope provenance differs from migration evidence')
      omittedColumns.supplier_price_imports = ['scope_known']
    } else {
      assert.fail('Restore comparison requires a reviewed migration: ' + version)
    }
  }
  return { omittedColumns, maxMigrationVersion: sourceVersion }
}

function databaseFingerprint(db, photoUrls = new Map(), options = {}) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_stat%' AND name<>'backup_assets' ORDER BY name").all()
  const result = {}
  for (const { name } of tables) {
    const omitted = options.omittedColumns?.[name] ?? []
    const projection = omitted.length
      ? db.prepare('PRAGMA table_info(' + quoted(name) + ')').all()
        .filter(column => !omitted.includes(column.name)).map(column => quoted(column.name)).join(', ')
      : '*'
    const migrationLimit = name === 'schema_migrations' && Number.isInteger(options.maxMigrationVersion)
      ? ' WHERE version <= ' + options.maxMigrationVersion : ''
    const statement = db.prepare('SELECT ' + projection + ' FROM ' + quoted(name) + migrationLimit)
    statement.setReadBigInts(true)
    const hashes = []
    for (const row of statement.iterate()) {
      if (name === 'products' && photoUrls.has(row.photo_url)) row.photo_url = photoUrls.get(row.photo_url)
      const values = Object.entries(row).map(([key, value]) => [key, valueHash(value)])
      hashes.push(createHash('sha256').update(JSON.stringify(values)).digest('hex'))
    }
    hashes.sort()
    result[name] = { rows: hashes.length, hash: createHash('sha256').update(hashes.join('\n')).digest('hex') }
  }
  return result
}
function assertDisposable(root) {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  assert(path.basename(root).startsWith('forsage-restore-readiness-'))
  assert.equal(fs.realpathSync(root), root)
  function walk(directory) {
    for (const name of fs.readdirSync(directory)) {
      const entry = path.join(directory, name), stat = fs.lstatSync(entry)
      assert(!stat.isSymbolicLink(), 'Refuse redirected cleanup')
      if (stat.isDirectory()) walk(entry)
    }
  }
  walk(root)
}
function assertStandaloneBackup(source) {
  assert(typeof source === 'string' && path.isAbsolute(source), 'Pass an absolute path to a standalone backup')
  source = fs.realpathSync(source)
  assert(!/[\\/]data[\\/]forsage\.db$/i.test(source), 'Never use the live database as a restore fixture')
  assert(fs.statSync(source).isFile(), 'Backup must be a regular file')
  for (const suffix of ['-wal', '-shm', '-journal']) assert(!fs.existsSync(source + suffix), 'Use a standalone backup without SQLite sidecars')
  return source
}
async function verifyRestore(source, compiledRoot = path.resolve(__dirname, '../dist'), previousSource) {
  source = assertStandaloneBackup(source)
  if (previousSource !== undefined) previousSource = assertStandaloneBackup(previousSource)
  const { LocalDatabase } = require(path.join(path.resolve(compiledRoot), 'db/localDatabase.js'))
  const { LOCAL_SCHEMA_VERSION } = require(path.join(path.resolve(compiledRoot), 'db/schema.js'))
  const beforeHash = fileHash(source)
  const previousSourceHash = previousSource === undefined ? undefined : fileHash(previousSource)
  LocalDatabase.assertBackupIsUsable(source)
  if (previousSource !== undefined) LocalDatabase.assertBackupIsUsable(previousSource)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-restore-readiness-'))
  let opened, probe
  const started = performance.now()
  try {
    assertDisposable(root)
    const live = path.join(root, 'data', 'forsage.db')
    if (previousSource !== undefined) {
      fs.mkdirSync(path.dirname(live))
      fs.copyFileSync(previousSource, live, fs.constants.COPYFILE_EXCL)
      assert.equal(fileHash(live), previousSourceHash)
    }
    opened = LocalDatabase.open(root).database
    opened.exec('CREATE TABLE readiness_previous(value INTEGER); INSERT INTO readiness_previous VALUES(101)')
    const expectedPrevious = databaseFingerprint(opened)
    opened.close(); opened = undefined
    const previousHash = fileHash(live), previousBytes = fs.statSync(live).size
    const candidateName = 'Forsage-2000-01-01_readiness.db'
    const candidate = path.join(root, 'backups', candidateName)
    fs.copyFileSync(source, candidate, fs.constants.COPYFILE_EXCL)
    assert.equal(fileHash(candidate), beforeHash)
    const photos = new Map(), embedded = new Map(), { pathToFileURL } = require('node:url')
    probe = new DatabaseSync(candidate, { readOnly: true, timeout: 5000 })
    if (probe.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='backup_assets'").get()) {
      for (const row of probe.prepare('SELECT original_url, sha256 FROM backup_assets WHERE bytes IS NOT NULL').iterate()) {
        embedded.set(row.original_url, row.sha256)
        const marker = 'backup-photo-sha256:' + row.sha256
        photos.set(row.original_url, marker)
        photos.set(pathToFileURL(path.join(root, 'photos', 'restored-' + row.sha256 + '.jpg')).href, marker)
      }
    }
    const references = probe.prepare("SELECT id, photo_url FROM products WHERE photo_url LIKE 'file:%'").all()
    const sourceSchemaVersion = Number(probe.prepare('SELECT MAX(version) version FROM schema_migrations').get().version)
    const expected = databaseFingerprint(probe, photos)
    probe.close(); probe = undefined
    const restoreStarted = performance.now()
    LocalDatabase.stageBackupForRestart(root, candidateName)
    const restoreElapsedMs = Math.round(performance.now() - restoreStarted)
    opened = LocalDatabase.open(root).database
    for (const [original, hash] of embedded) {
      const target = path.join(root, 'photos', 'restored-' + hash + '.jpg')
      assert.equal(fileHash(target), hash, 'Restored photo bytes differ')
      for (const row of references.filter(item => item.photo_url === original)) {
        assert.equal(opened.prepare('SELECT photo_url FROM products WHERE id=?').get(row.id).photo_url,
          pathToFileURL(target).href, 'Restored product still references the old photo location')
      }
    }
    const comparison = restoreComparisonOptions(opened, sourceSchemaVersion, LOCAL_SCHEMA_VERSION)
    const actual = databaseFingerprint(opened, photos, comparison)
    assert.deepEqual(actual, expected, 'Restored rows differ from the selected backup')
    opened.close(); opened = undefined
    const quarantined = fs.readdirSync(path.join(root, 'corrupt')).filter(name => name.endsWith('.db'))
    assert.equal(quarantined.length, 1)
    const retained = path.join(root, 'corrupt', quarantined[0])
    assert.equal(fileHash(retained), previousHash, 'Previous database bytes differ')
    probe = new DatabaseSync(retained, { readOnly: true })
    assert.equal(probe.prepare('PRAGMA quick_check').get().quick_check, 'ok')
    assert.deepEqual(databaseFingerprint(probe), expectedPrevious, 'Previous database rows differ')
    assert.equal(probe.prepare('SELECT value FROM readiness_previous').get().value, 101)
    probe.close(); probe = undefined
    assert.equal(fileHash(source), beforeHash, 'Original backup changed')
    return {
      source: path.basename(source), sourceUnchanged: true, rowsIdentical: true,
      sourceSchemaVersion, restoredSchemaVersion: LOCAL_SCHEMA_VERSION,
      previousFixturePreserved: true, previousRowsIdentical: true,
      previousFixtureMode: previousSource === undefined ? 'synthetic' : 'full-backup',
      previousSource: previousSource === undefined ? undefined : path.basename(previousSource),
      previousSourceUnchanged: previousSource === undefined ? undefined : fileHash(previousSource) === previousSourceHash,
      previousBytes, previousTables: Object.keys(expectedPrevious).length,
      previousProducts: expectedPrevious.products?.rows, previousSales: expectedPrevious.sales?.rows,
      restoreElapsedMs, tables: Object.keys(actual).length,
      embeddedPhotosVerified: embedded.size,
      externalPhotoReferences: references.filter(row => !embedded.has(row.photo_url)).length,
      products: actual.products?.rows, sales: actual.sales?.rows,
      invoices: actual.supply_invoices?.rows, orders: actual.customer_orders?.rows,
      databaseFingerprint: createHash('sha256').update(JSON.stringify(actual)).digest('hex'),
      elapsedMs: Math.round(performance.now() - started),
    }
  } finally {
    probe?.close(); opened?.close()
    assertDisposable(root)
    fs.rmSync(root, { recursive: true, force: true })
    assert.equal(fileHash(source), beforeHash, 'Original selected backup changed')
    if (previousSource !== undefined) assert.equal(fileHash(previousSource), previousSourceHash, 'Original previous backup changed')
  }
}
module.exports = { databaseFingerprint, restoreComparisonOptions, assertStandaloneBackup, verifyRestore }
if (require.main === module) {
  verifyRestore(process.argv[2] || '', process.argv[3], process.argv[4]).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.code || error.name, String(error.message).slice(0, 250)); process.exitCode = 1 })
}
