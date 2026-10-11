// Real Windows sharing violation, not a mocked filesystem error.
// This helper never starts the application or opens the working shop database.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const staged = process.argv.includes('--staged')
const compiled = path.resolve(__dirname, staged ? '../release/staged/win-unpacked/resources/app.asar/dist' : '../dist')
const { LocalDatabase } = require(path.join(compiled, 'db/localDatabase.js'))
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function assertFixture(root) {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  assert(path.basename(root).startsWith('forsage-restore-lock-'))
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

async function lockFixture(root, file, sharing) {
  assertFixture(root)
  assert.equal(file, path.join(root, 'data', 'forsage.db'))
  assert(['Read', 'None'].includes(sharing))
  const source = [
    "$ErrorActionPreference = 'Stop'",
    '$lockStream = [System.IO.File]::Open($env:FORSAGE_TEST_LOCK_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::' + sharing + ')',
    "try { [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null }",
    'finally { $lockStream.Dispose() }',
  ].join('\n')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(source, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORSAGE_TEST_LOCK_FILE: file },
  })
  let errorText = '', exited = false
  child.stderr.on('data', data => { errorText = (errorText + data).slice(-1500) })
  child.stdin.on('error', () => {}) // An early child exit is handled by its exit promise.
  const exit = new Promise(resolve => {
    child.once('error', error => { exited = true; resolve({ error }) })
    child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }) })
  })
  const release = async () => {
    let timer
    if (!exited) child.stdin.end('\n')
    try {
      const result = await Promise.race([exit, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Fixture lock release timed out')), 5000)
      })])
      if (result.error) throw result.error
      assert.equal(result.code, 0, 'Fixture lock child failed: ' + errorText)
    } finally {
      clearTimeout(timer)
      if (!exited) { child.kill(); await exit }
    }
  }
  try {
    let timer, readyText = ''
    const onOutput = []
    try {
      await Promise.race([
        new Promise(resolve => {
          const listener = data => {
            readyText += data
            if (readyText.includes('LOCKED')) resolve()
          }
          onOutput.push(listener); child.stdout.on('data', listener)
        }),
        exit.then(result => { throw result.error || new Error('Lock child exited before readiness: ' + errorText) }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture lock readiness timed out')), 10000) }),
      ])
    } finally {
      clearTimeout(timer)
      for (const listener of onOutput) child.stdout.removeListener('data', listener)
    }
    return release
  } catch (error) {
    await release().catch(() => {})
    throw error
  }
}

async function run(sharing) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-restore-lock-'))
  let db, release
  try {
    assertFixture(root)
    db = LocalDatabase.open(root).database
    db.exec('CREATE TABLE restore_lock_probe(value INTEGER); INSERT INTO restore_lock_probe VALUES(98)')
    const backup = await db.backupNow()
    db.exec('UPDATE restore_lock_probe SET value=101')
    db.close(); db = undefined
    const live = path.join(root, 'data', 'forsage.db')
    const previousHash = hash(live), backupHash = hash(backup)
    release = await lockFixture(root, live, sharing)
    let failure
    try { LocalDatabase.stageBackupForRestart(root, path.basename(backup)) }
    catch (error) { failure = error }
    assert(failure, 'Restore must not bypass an OS file lock')
    assert(['EPERM', 'EACCES', 'EBUSY'].includes(failure.code), 'Expected OS sharing violation, got ' + failure.code)
    if (sharing === 'Read') assert.equal(failure.syscall, 'rename', 'Must reach the real final replacement')
    assert(fs.existsSync(live), 'Locked working filename disappeared')
    assert.equal(hash(backup), backupHash, 'Selected backup changed')
    await release(); release = undefined
    assert.equal(hash(live), previousHash, 'Locked previous DB changed')
    const retainedRoot = path.join(root, 'corrupt')
    const retained = fs.existsSync(retainedRoot) ? fs.readdirSync(retainedRoot).filter(name => name.endsWith('.db')) : []
    assert.equal(retained.length, sharing === 'Read' ? 1 : 0)
    for (const name of retained) assert.equal(hash(path.join(retainedRoot, name)), previousHash)
    db = LocalDatabase.open(root).database
    assert.equal(db.prepare('SELECT value FROM restore_lock_probe').get().value, 101)
    db.close(); db = undefined
    LocalDatabase.stageBackupForRestart(root, path.basename(backup))
    db = LocalDatabase.open(root).database
    assert.equal(db.prepare('SELECT value FROM restore_lock_probe').get().value, 98)
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
    db.close(); db = undefined
    assert.equal(hash(backup), backupHash)
    return { sharing, osError: failure.code, syscall: failure.syscall, previousUnchanged: true,
      selectedBackupUnchanged: true, previousValue: 101, restoredValue: 98, retryCompleted: true }
  } finally {
    if (release) await release()
    db?.close()
    assertFixture(root)
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function main() {
  assert.equal(process.platform, 'win32', 'Run this OS-specific check on Windows; do not report it as passed elsewhere')
  const results = []
  for (const sharing of ['Read', 'None']) results.push(await run(sharing))
  console.log(JSON.stringify({ staged, windowsFileLocks: results }))
}
main().catch(error => { console.error(error.code || error.name, String(error.message).slice(0, 300)); process.exitCode = 1 })
