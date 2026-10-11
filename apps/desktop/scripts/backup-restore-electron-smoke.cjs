// Exercise restore and natural application shutdown in Electron's normal runtime.
// Only explicitly selected standalone backups are read; all writes use temp fixtures.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { assertStandaloneBackup, verifyRestore } = require('./backup-restore-readiness.cjs')
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function assertDisposable(root) {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  assert(path.basename(root).startsWith('forsage-restore-electron-'))
  assert.equal(fs.realpathSync(root), root)
  function check(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      assert(!fs.lstatSync(file).isSymbolicLink(), 'Refuse redirected cleanup')
      if (entry.isDirectory()) check(file)
    }
  }
  check(root)
}

function assertCleanRestoreExit(result) {
  if (result.error) throw result.error
  assert.equal(result.signal, null, 'Electron was terminated')
  assert.equal(result.status, 0, 'Electron did not exit cleanly')
  const reports = (result.stdout || '').split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line))
  assert.equal(reports.length, 1)
  assert.equal(reports[0].runtime, 'electron-application')
  assert.equal(reports[0].rowsIdentical, true)
  assert.equal(reports[0].previousRowsIdentical, true)
  assert.equal(reports[0].sourceUnchanged, true)
  assert.equal(reports[0].previousSourceUnchanged, true)
  return reports[0]
}

async function createSyntheticBackups(root, compiled, source, previous) {
  // The entire fixture is inside this invocation's owned directory.
  assertDisposable(root)
  assert.equal(source, path.join(root, 'selected.db'))
  assert.equal(previous, path.join(root, 'previous.db'))
  const { LocalDatabase } = require(path.join(compiled, 'db/localDatabase.js'))
  const { LocalCatalogRepository } = require(path.join(compiled, 'repositories/catalogRepository.js'))
  const { embedBackupPhotos } = require(path.join(compiled, 'backup/embeddedPhotos.js'))
  const { createVerifiedBackup } = require(path.join(compiled, 'db/verifiedBackup.js'))
  const { pathToFileURL } = require('node:url')
  const store = path.join(root, 'synthetic-store')
  let db = new LocalDatabase(store)
  try {
    const photo = path.join(store, 'photos', 'fixture.jpg')
    fs.mkdirSync(path.dirname(photo))
    fs.writeFileSync(photo, Buffer.from('synthetic backup photo'), { flag: 'wx' })
    const catalog = new LocalCatalogRepository(db)
    db.transaction(() => {
      for (let index = 0; index < 200; index += 1) catalog.saveProduct({
        id: 'restore-exit-product-' + index, sku: 'RESTORE-EXIT-' + index,
        name: 'Synthetic restore item ' + index, qty_on_hand: index + 1,
        photo_url: index === 0 ? pathToFileURL(photo).href : null,
      })
    })
    // Exercise the real worker-thread lifecycle in normal Electron as well.
    // Its promise resolves only after validation AND worker exit, not on a message.
    await createVerifiedBackup(db.databasePath, previous)
    db.prepare('UPDATE products SET qty_on_hand=98 WHERE id=?').run('restore-exit-product-0')
    await createVerifiedBackup(db.databasePath, source)
    db.close(); db = undefined
    await embedBackupPhotos(source, store)
    assertStandaloneBackup(source)
    assertStandaloneBackup(previous)
    return { backgroundBackupsVerified: 2 }
  } finally { db?.close() }
}

// Electron loads its entry through its bootstrap, so require.main may differ.
if (process.versions.electron && process.argv.includes('--restore-child')) {
  const { app, session } = require('electron')
  assert(app, 'The child must use the normal Electron application runtime')
  const start = process.argv.indexOf('--restore-child') + 1
  const [source, compiled, previous, root, mode] = process.argv.slice(start)
  assertDisposable(root)
  app.setPath('userData', path.join(root, 'profile'))
  app.setPath('crashDumps', path.join(root, 'crashes'))
  app.disableHardwareAcceleration()
  const deadline = setTimeout(() => { console.error('Restore application probe timed out'); app.exit(1) }, 60000)
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
      (_request, done) => done({ cancel: true }))
    const evidence = mode === '--synthetic' ? await createSyntheticBackups(root, compiled, source, previous) : {}
    const result = await verifyRestore(source, compiled, previous)
    clearTimeout(deadline)
    process.stdout.write(JSON.stringify({ ...result, ...evidence, runtime: 'electron-application', shopDatabaseOpened: false }) + '\n',
      () => app.quit())
  }).catch(error => {
    clearTimeout(deadline)
    console.error(error.code || error.name, String(error.message).slice(0, 250))
    app.exit(1)
  })
} else if (require.main === module) {
  assert(!process.versions.electron, 'Run this controller with Node, not Electron')
  const synthetic = process.argv.includes('--synthetic')
  const inputs = process.argv.slice(2).filter(value => !['--staged', '--synthetic'].includes(value))
  assert.equal(inputs.length, synthetic ? 0 : 2, 'Pass two absolute standalone backups, or --synthetic with no input files')
  const externalInputs = inputs.map(assertStandaloneBackup)
  const before = externalInputs.map(hash)
  const staged = process.argv.includes('--staged')
  const compiled = path.resolve(__dirname, staged ? '../release/staged/win-unpacked/resources/app.asar/dist' : '../dist')
  assert(fs.existsSync(staged ? path.resolve(__dirname, '../release/staged/win-unpacked/resources/app.asar')
    : path.join(compiled, 'db/localDatabase.js')), 'Build the selected runtime before testing')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-restore-electron-'))
  const [source, previous] = synthetic ? [path.join(root, 'selected.db'), path.join(root, 'previous.db')] : externalInputs
  try {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(require('electron'), [__filename, '--restore-child', source, compiled, previous, root, ...(synthetic ? ['--synthetic'] : [])],
      { env, windowsHide: true, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 })
    process.stdout.write(result.stdout || '')
    process.stderr.write(result.stderr || '')
    const report = assertCleanRestoreExit(result)
    if (synthetic) {
      assert.equal(report.products, 200)
      assert.equal(report.embeddedPhotosVerified, 1)
      assert.equal(report.backgroundBackupsVerified, 2)
    }
    console.log(JSON.stringify({ normalElectronExit: true, staged, synthetic, exitCode: result.status }))
  } finally {
    assert.deepEqual(externalInputs.map(hash), before, 'An original backup changed')
    assertDisposable(root)
    fs.rmSync(root, { recursive: true, force: true })
  }
}

module.exports = { assertCleanRestoreExit }
