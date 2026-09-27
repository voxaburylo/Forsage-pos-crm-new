// Fault injection in disposable fake EXEs. Never uses the installed program or shop data.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { installRelease, sha256 } = require('./install-release.cjs')
function inputAt(root) {
  const source = path.join(root, 'new.exe'), destination = path.join(root, 'Forsage.exe')
  return { source, destination, rollback: path.join(root, 'rollback/before.exe'), expectedHash: sha256(source), checkClosed() {} }
}
if (process.argv[2] === '--child') {
  const phase = process.argv[3], input = inputAt(process.argv[4])
  const open = fs.openSync, write = fs.writeSync, rename = fs.renameSync, unlink = fs.unlinkSync
  let copyFd = -1
  fs.openSync = function(file, flags, ...args) {
    const fd = open(file, flags, ...args)
    if (flags === 'wx' && String(file) === (phase === 'new-copy' ? input.destination : input.rollback) + '.pending') copyFd = fd
    return fd
  }
  fs.writeSync = function(fd, buffer, offset, length, ...args) {
    if ((phase === 'new-copy' || phase === 'rollback-copy') && fd === copyFd) {
      write(fd, buffer, offset, Math.min(3, length), ...args)
      process.exit(73)
    }
    return write(fd, buffer, offset, length, ...args)
  }
  fs.renameSync = function(from, to) {
    if (phase === 'before-commit' && from === input.destination + '.pending') process.exit(73)
    const result = rename(from, to)
    if (phase === 'after-commit' && from === input.destination + '.pending') process.exit(73)
    if (phase === 'after-rollback' && from === input.rollback + '.pending') process.exit(73)
    return result
  }
  fs.unlinkSync = function(file) {
    if (phase === 'release-lock' && String(file).endsWith('.update-lock')) process.exit(73)
    return unlink(file)
  }
  installRelease(input)
  throw Error('Fault injection did not stop the child')
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-release-crash-'))
  try {
    for (const phase of ['new-copy', 'rollback-copy', 'before-commit', 'after-commit', 'after-rollback', 'release-lock']) {
      const directory = path.join(root, phase); fs.mkdirSync(path.join(directory, 'rollback'), { recursive: true })
      fs.writeFileSync(path.join(directory, 'new.exe'), 'MZ-new-test-release')
      fs.writeFileSync(path.join(directory, 'Forsage.exe'), 'MZ-old-test-release')
      fs.writeFileSync(path.join(directory, 'rollback/before.exe'), 'MZ-earlier-rollback')
      fs.writeFileSync(path.join(directory, 'forsage.db'), 'untouched test data')
      const input = inputAt(directory), previous = sha256(input.destination), earlier = sha256(input.rollback)
      const result = spawnSync(process.execPath, [__filename, '--child', phase, directory], { windowsHide: true, encoding: 'utf8', timeout: 30000 })
      assert.equal(result.status, 73, phase + ': ' + (result.error?.message || result.stderr))
      assert.equal(sha256(input.source), input.expectedHash)
      assert.equal(fs.readFileSync(path.join(directory, 'forsage.db'), 'utf8'), 'untouched test data')
      const committed = ['after-commit', 'after-rollback', 'release-lock'].includes(phase)
      assert.equal(sha256(input.destination), committed ? input.expectedHash : previous, phase)
      if (phase === 'after-commit') assert.equal(sha256(input.rollback + '.pending'), previous)
      if (['after-rollback', 'release-lock'].includes(phase)) assert.equal(sha256(input.rollback), previous)
      else assert.equal(sha256(input.rollback), earlier)
      assert(fs.existsSync(input.destination + '.update-lock'), phase + ': retained recovery lock')
      const journal = JSON.parse(fs.readFileSync(input.destination + '.update-lock', 'utf8'))
      assert.equal(journal.previousHash, previous)
      assert.equal(journal.expectedHash, input.expectedHash)
      assert.throws(() => installRelease(input), /already running or interrupted/)
      console.log('PASS interrupted update: ' + phase)
    }
    console.log('PASS: six abrupt child exits, intact installed EXE, recoverable previous release, blocked automatic retry, untouched fixture data')
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert(path.basename(root).startsWith('forsage-release-crash-'))
    fs.rmSync(root, { recursive: true, force: true })
  }
}
