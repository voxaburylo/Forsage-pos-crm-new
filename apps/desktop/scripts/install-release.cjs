// Local, operator-invoked update. No network, process termination or database access.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const normalize = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
function sha256(file) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(512 * 1024), fd = fs.openSync(file, 'r')
  try { let length; while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length)) }
  finally { fs.closeSync(fd) }
  return hash.digest('hex')
}
function optionalStat(file) {
  try { return fs.lstatSync(file, { bigint: true }) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function assertPlainFile(file) {
  const resolved = path.resolve(file)
  const stat = fs.lstatSync(resolved, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
    || normalize(fs.realpathSync(resolved)) !== normalize(resolved)) throw new Error('Refusing redirected or hard-linked release file')
  return resolved
}
function assertPlainDirectory(directory) {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(fs.realpathSync(directory)) !== normalize(directory))
    throw new Error('Refusing redirected update directory')
}
function prepareParent(file) {
  const directory = path.dirname(file)
  let existing = directory
  while (!optionalStat(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) throw new Error('Update directory is unavailable')
    existing = parent
  }
  // Check before mkdir too: never create directories through a junction.
  assertPlainDirectory(existing)
  fs.mkdirSync(directory, { recursive: true })
  assertPlainDirectory(directory)
}
function sameFile(stat, expected) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
    && stat.dev === expected.dev && stat.ino === expected.ino && stat.birthtimeNs === expected.birthtimeNs
}
function removeOwned(entries) {
  const errors = []
  for (const entry of [...entries].reverse()) {
    try {
      const stat = optionalStat(entry.path)
      if (!stat) continue
      assertPlainFile(entry.path)
      if (!sameFile(stat, entry.stat)) throw new Error('Update file was replaced; retained for inspection: ' + entry.path)
      fs.unlinkSync(entry.path)
    } catch (error) { errors.push(error) }
  }
  return errors
}
function copyNew(source, destination, owned) {
  assertPlainFile(source); assertPlainDirectory(path.dirname(destination))
  const output = fs.openSync(destination, 'wx')
  owned.push({ path: destination, stat: fs.fstatSync(output, { bigint: true }) })
  let input
  try {
    input = fs.openSync(source, 'r')
    const buffer = Buffer.allocUnsafe(512 * 1024)
    let length
    while ((length = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) {
      let offset = 0
      while (offset < length) {
        const written = fs.writeSync(output, buffer, offset, length - offset)
        if (written <= 0) throw new Error('Incomplete update write')
        offset += written
      }
    }
    fs.fsyncSync(output)
  } finally {
    try { if (input !== undefined) fs.closeSync(input) }
    finally { fs.closeSync(output) }
  }
}
function assertShopClosed() {
  if (process.platform !== 'win32') throw new Error('Windows installer required')
  // Fail closed if Windows cannot inspect processes. Never kill a running till.
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^Forsage(?:-.*)?\\.exe$' }).Count"],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim()
  if (result !== '0') throw new Error('Закрийте Форсаж зі збереженням роботи. EXE не замінено.')
}
function installRelease({ source, destination, rollback, expectedHash, checkClosed = assertShopClosed }) {
  if (!/^[a-f0-9]{64}$/i.test(expectedHash || '')) throw new Error('Expected SHA-256 is required')
  source = assertPlainFile(source); destination = assertPlainFile(destination)
  rollback = path.resolve(rollback)
  const paths = [source, destination, rollback].map(normalize)
  if (new Set(paths).size !== 3 || !paths.every(file => file.endsWith('.exe'))) throw new Error('Invalid release paths')
  if (sha256(source) !== expectedHash.toLowerCase()) throw new Error('Release checksum mismatch; installed EXE unchanged')
  const header = Buffer.alloc(2), sourceFd = fs.openSync(source, 'r')
  try { fs.readSync(sourceFd, header, 0, 2, 0) } finally { fs.closeSync(sourceFd) }
  if (header.toString() !== 'MZ') throw new Error('Release is not a Windows executable')
  checkClosed()
  prepareParent(rollback)
  if (optionalStat(rollback)) assertPlainFile(rollback)
  const beforeHash = sha256(destination)
  const staged = destination + '.pending', rollbackStaged = rollback + '.pending', restoreStaged = destination + '.restore-pending'
  const locks = [], owned = []
  let installed = false, rollbackCommitted = false, retainRecovery = false, operationError
  try {
    // Lock both resources. A crashed process leaves a marker; never guess it is safe to erase it.
    for (const target of [destination, rollback].sort()) {
      const lockPath = target + '.update-lock'
      let fd
      try { fd = fs.openSync(lockPath, 'wx') }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('Update already running or interrupted; inspect update-lock before retrying')
        throw error
      }
      locks.push({ path: lockPath, stat: fs.fstatSync(fd, { bigint: true }) })
      try {
        fs.writeFileSync(fd, JSON.stringify({ format: 1, pid: process.pid, source, destination, rollback, expectedHash, previousHash: beforeHash, startedAt: new Date().toISOString() }))
        fs.fsyncSync(fd)
      } finally { fs.closeSync(fd) }
    }
    for (const file of [staged, rollbackStaged, restoreStaged])
      if (optionalStat(file)) throw new Error('Previous update file exists; inspect it before retrying: ' + file)
    assertPlainFile(destination)
    if (sha256(destination) !== beforeHash) throw new Error('Installed executable changed while acquiring update locks')
    if (beforeHash === expectedHash.toLowerCase())
      return { alreadyInstalled: true, installedHash: beforeHash, previousHash: optionalStat(rollback) ? sha256(rollback) : null, rollback }

    copyNew(source, staged, owned)
    if (sha256(staged) !== expectedHash.toLowerCase()) throw new Error('Staged copy verification failed')
    copyNew(destination, rollbackStaged, owned)
    if (sha256(rollbackStaged) !== beforeHash) throw new Error('Rollback copy verification failed')
    checkClosed()
    assertPlainFile(destination)
    if (sha256(destination) !== beforeHash) throw new Error('Installed executable changed during update')
    assertPlainFile(staged); assertPlainFile(rollbackStaged)
    fs.renameSync(staged, destination)
    installed = true
    if (sha256(destination) !== expectedHash.toLowerCase()) throw new Error('Installed release verification failed')
    // Keep the previous rollback untouched until the installed new executable is verified.
    if (optionalStat(rollback)) assertPlainFile(rollback)
    fs.renameSync(rollbackStaged, rollback)
    rollbackCommitted = true
    if (sha256(rollback) !== beforeHash) throw new Error('Published rollback verification failed')
    return { alreadyInstalled: false, installedHash: expectedHash.toLowerCase(), previousHash: beforeHash, rollback }
  } catch (error) {
    operationError = error
    if (installed) {
      try {
        const recovery = rollbackCommitted ? rollback : rollbackStaged
        assertPlainFile(recovery)
        if (sha256(recovery) !== beforeHash) throw new Error('Recovery checksum mismatch')
        copyNew(recovery, restoreStaged, owned)
        if (sha256(restoreStaged) !== beforeHash) throw new Error('Recovery staging verification failed')
        // Never stream a rollback over the installed EXE: a failed copy must leave it whole.
        fs.renameSync(restoreStaged, destination)
        if (sha256(destination) !== beforeHash) throw new Error('Restored release verification failed')
      } catch (recoveryError) {
        retainRecovery = true
        throw new AggregateError([error, recoveryError], 'Update failed and rollback needs manual recovery. Verified recovery files and update-lock retained; do not retry automatically.')
      }
    }
    throw error
  } finally {
    if (!retainRecovery) {
      const cleanupErrors = removeOwned(owned)
      if (!cleanupErrors.length) cleanupErrors.push(...removeOwned(locks))
      if (cleanupErrors.length) throw new AggregateError([...(operationError ? [operationError] : []), ...cleanupErrors],
        'Update cleanup needs inspection; recovery files may remain. Do not retry automatically.')
    }
  }
}
module.exports = { installRelease, sha256, assertShopClosed }
if (require.main === module) {
  const project = path.resolve(__dirname, '..')
  const version = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version
  const name = `Forsage-${version}-portable.exe`
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is unavailable')
  const result = installRelease({
    source: path.join(project, 'release/staged', name),
    destination: path.join(project, 'release', name),
    rollback: path.join(process.env.LOCALAPPDATA, 'Forsage/old-builds/Forsage-before-update.exe'),
    expectedHash: process.argv[2],
  })
  console.log(JSON.stringify(result))
}
