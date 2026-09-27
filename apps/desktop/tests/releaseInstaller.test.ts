import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, linkSync, symlinkSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
const require = createRequire(import.meta.url)
// Only signatures exercised by this CommonJS installer fixture.
const fs: {
  openSync: (file: string, flags: string) => number
  writeSync: (fd: number, buffer: Buffer, offset: number, length: number) => number
  renameSync: (from: string, to: string) => void
  fsyncSync: (fd: number) => void
} = require('node:fs')
const { installRelease, sha256 } = require('../scripts/install-release.cjs')
const roots: string[] = []
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'forsage-install-test-')); roots.push(root)
  const source = path.join(root, 'new.exe'), destination = path.join(root, 'Forsage.exe'), rollback = path.join(root, 'old-builds/before.exe')
  writeFileSync(source, 'MZ-new-test-executable'); writeFileSync(destination, 'MZ-old-test-executable')
  writeFileSync(path.join(root, 'forsage.db'), 'untouched database placeholder')
  return { source, destination, rollback, expectedHash: sha256(source), checkClosed: () => {}, root }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-install-test-')) rmSync(root, { recursive: true, force: true })
})
it('replaces only the existing executable and keeps one verified rollback without touching data', () => {
  const input = fixture(), previous = sha256(input.destination)
  const result = installRelease(input)
  expect(sha256(input.destination)).toBe(input.expectedHash)
  expect(sha256(input.rollback)).toBe(previous)
  expect(result.previousHash).toBe(previous)
  expect(readFileSync(path.join(input.root, 'forsage.db'), 'utf8')).toBe('untouched database placeholder')
  expect(existsSync(input.destination + '.pending')).toBe(false)
})
it('rejects a modified package before changing the installed executable', () => {
  const input = fixture(), previous = sha256(input.destination)
  writeFileSync(input.source, 'MZ-corrupt')
  expect(() => installRelease(input)).toThrow('checksum mismatch')
  expect(sha256(input.destination)).toBe(previous)
  expect(existsSync(input.rollback)).toBe(false)
})
it('does not replace the executable if the shop starts while staging the update', () => {
  const input = fixture(), previous = sha256(input.destination)
  mkdirSync(path.dirname(input.rollback), { recursive: true })
  writeFileSync(input.rollback, 'MZ-earlier-rollback')
  const previousRollback = sha256(input.rollback)
  let checks = 0
  input.checkClosed = () => { if (++checks === 2) throw Error('Shop running') }
  expect(() => installRelease(input)).toThrow('Shop running')
  expect(sha256(input.destination)).toBe(previous)
  expect(sha256(input.rollback)).toBe(previousRollback)
  expect(existsSync(input.destination + '.pending')).toBe(false)
})
it('does not overwrite an interrupted-update staging file or accept a non-executable', () => {
  const input = fixture(), previous = sha256(input.destination)
  writeFileSync(input.destination + '.pending', 'investigate me')
  expect(() => installRelease(input)).toThrow('Previous update file')
  expect(readFileSync(input.destination + '.pending', 'utf8')).toBe('investigate me')
  writeFileSync(input.source, 'not executable'); input.expectedHash = sha256(input.source)
  expect(() => installRelease(input)).toThrow('not a Windows executable')
  expect(sha256(input.destination)).toBe(previous)
})

it('keeps the previous rollback when the same release is installed again', () => {
  const input = fixture(), previous = sha256(input.destination)
  installRelease(input)
  const result = installRelease(input)
  expect(result.alreadyInstalled).toBe(true)
  expect(sha256(input.rollback)).toBe(previous)
})

it('rejects a rollback hard link to the source without damaging either executable', () => {
  const input = fixture(), previous = sha256(input.destination)
  mkdirSync(path.dirname(input.rollback), { recursive: true })
  linkSync(input.source, input.rollback)
  expect(() => installRelease(input)).toThrow(/link|alias/i)
  expect(sha256(input.source)).toBe(input.expectedHash)
  expect(sha256(input.destination)).toBe(previous)
})

function seedRollback(input: ReturnType<typeof fixture>) {
  mkdirSync(path.dirname(input.rollback), { recursive: true })
  writeFileSync(input.rollback, 'MZ-earlier-valid-rollback')
  return sha256(input.rollback)
}
function expectClean(input: ReturnType<typeof fixture>) {
  for (const file of [input.destination + '.pending', input.destination + '.restore-pending',
    input.rollback + '.pending', input.destination + '.update-lock', input.rollback + '.update-lock'])
    expect(existsSync(file), file).toBe(false)
  expect(readFileSync(path.join(input.root, 'forsage.db'), 'utf8')).toBe('untouched database placeholder')
}
it.each(['destination', 'rollback'] as const)('rejects hard-linked %s before any writes', target => {
  const input = fixture(), before = readFileSync(input.destination)
  if (target === 'rollback') {
    mkdirSync(path.dirname(input.rollback), { recursive: true })
    linkSync(input.destination, input.rollback)
  } else linkSync(input.destination, path.join(input.root, 'alias.exe'))
  expect(() => installRelease(input)).toThrow(/hard-linked/)
  expect(readFileSync(input.destination)).toEqual(before)
  expect(sha256(input.source)).toBe(input.expectedHash)
  expectClean(input)
})
it('rejects a rollback parent junction before creating directories through it', () => {
  const input = fixture()
  const outside = path.join(input.root, 'other-data'); mkdirSync(outside)
  const link = path.join(input.root, 'redirect'); symlinkSync(outside, link, 'junction')
  input.rollback = path.join(link, 'new-subdirectory', 'before.exe')
  expect(() => installRelease(input)).toThrow(/redirected update directory/)
  expect(readdirSync(outside)).toEqual([])
  expectClean(input)
})
it.each(['destination', 'rollback'] as const)('does not overwrite a previous %s update lock', target => {
  const input = fixture(), oldRollback = seedRollback(input), before = sha256(input.destination)
  const lock = input[target] + '.update-lock'; writeFileSync(lock, 'prior interrupted update')
  expect(() => installRelease(input)).toThrow(/already running or interrupted/)
  expect(readFileSync(lock, 'utf8')).toBe('prior interrupted update')
  expect(sha256(input.destination)).toBe(before); expect(sha256(input.rollback)).toBe(oldRollback)
})
it('rejects a second installer while the first is preparing files', () => {
  const input = fixture()
  let checks = 0
  input.checkClosed = () => {
    if (++checks === 2) expect(() => installRelease({ ...input, checkClosed: () => {} })).toThrow(/already running/)
  }
  installRelease(input); expectClean(input)
})
it('serializes a shared rollback even for different destination executables', () => {
  const input = fixture(), other = path.join(input.root, 'second.exe'); writeFileSync(other, 'MZ-other-existing')
  let checks = 0
  input.checkClosed = () => {
    if (++checks === 2) expect(() => installRelease({ ...input, destination: other, checkClosed: () => {} })).toThrow(/already running/)
  }
  installRelease(input)
  expect(readFileSync(other, 'utf8')).toBe('MZ-other-existing')
  expect(existsSync(other + '.update-lock')).toBe(false); expectClean(input)
})
it.each(['new package', 'rollback copy'])('preserves both executables on a partial %s disk-full write', phase => {
  const input = fixture(), before = sha256(input.destination), oldRollback = seedRollback(input)
  const open = fs.openSync, write = fs.writeSync
  let targetFd = -1
  vi.spyOn(fs, 'openSync').mockImplementation((file: string, flags: string) => {
    const fd = open(file, flags)
    if (String(file) === (phase === 'new package' ? input.destination : input.rollback) + '.pending') targetFd = fd
    return fd
  })
  vi.spyOn(fs, 'writeSync').mockImplementation((fd: number, buffer: Buffer, offset: number, length: number) => {
    if (fd === targetFd) { write(fd, buffer, offset, Math.min(3, length)); throw Object.assign(Error('disk full'), { code: 'ENOSPC' }) }
    return write(fd, buffer, offset, length)
  })
  expect(() => installRelease(input)).toThrow('disk full')
  expect(sha256(input.destination)).toBe(before); expect(sha256(input.rollback)).toBe(oldRollback)
  expectClean(input)
})
it('keeps the old EXE and earlier rollback when committing the new EXE is denied', () => {
  const input = fixture(), before = sha256(input.destination), oldRollback = seedRollback(input)
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from: string, to: string) => {
    if (from === input.destination + '.pending') throw Error('Executable locked')
    return rename(from, to)
  })
  expect(() => installRelease(input)).toThrow('Executable locked')
  expect(sha256(input.destination)).toBe(before); expect(sha256(input.rollback)).toBe(oldRollback)
  expectClean(input)
})
it('atomically restores the old EXE when publishing the rollback fails', () => {
  const input = fixture(), before = sha256(input.destination), oldRollback = seedRollback(input)
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from: string, to: string) => {
    if (from === input.rollback + '.pending') throw Error('Rollback path locked')
    return rename(from, to)
  })
  expect(() => installRelease(input)).toThrow('Rollback path locked')
  expect(sha256(input.destination)).toBe(before); expect(sha256(input.rollback)).toBe(oldRollback)
  expectClean(input)
})
it('retains verified recovery files and locks when automatic rollback is blocked', () => {
  const input = fixture(), before = sha256(input.destination), oldRollback = seedRollback(input)
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from: string, to: string) => {
    if (from === input.rollback + '.pending' || from === input.destination + '.restore-pending') throw Error('Locked recovery path')
    return rename(from, to)
  })
  expect(() => installRelease(input)).toThrow(/manual recovery/)
  expect(sha256(input.destination)).toBe(input.expectedHash)
  expect(sha256(input.rollback)).toBe(oldRollback)
  expect(sha256(input.rollback + '.pending')).toBe(before)
  expect(sha256(input.destination + '.restore-pending')).toBe(before)
  expect(existsSync(input.destination + '.update-lock')).toBe(true)
  expect(existsSync(input.rollback + '.update-lock')).toBe(true)
  expect(() => installRelease(input)).toThrow(/already running or interrupted/)
})
it('keeps an unowned rollback staging file intact', () => {
  const input = fixture(), before = sha256(input.destination), oldRollback = seedRollback(input)
  writeFileSync(input.rollback + '.pending', 'prior recovery evidence')
  expect(() => installRelease(input)).toThrow('Previous update file')
  expect(sha256(input.destination)).toBe(before); expect(sha256(input.rollback)).toBe(oldRollback)
  expect(readFileSync(input.rollback + '.pending', 'utf8')).toBe('prior recovery evidence')
  expect(existsSync(input.destination + '.update-lock')).toBe(false)
})

it('rejects a source changed after its first checksum without replacing the old rollback', () => {
  const input = fixture(), before = sha256(input.destination), oldRollback = seedRollback(input)
  input.checkClosed = () => { writeFileSync(input.source, 'MZ-changed-package') }
  expect(() => installRelease(input)).toThrow('Staged copy verification failed')
  expect(sha256(input.destination)).toBe(before); expect(sha256(input.rollback)).toBe(oldRollback)
  expectClean(input)
})
it('does not overwrite an executable changed by another updater before commit', () => {
  const input = fixture(), oldRollback = seedRollback(input)
  let checks = 0
  input.checkClosed = () => { if (++checks === 2) writeFileSync(input.destination, 'MZ-unexpected-new-version') }
  expect(() => installRelease(input)).toThrow('Installed executable changed')
  expect(readFileSync(input.destination, 'utf8')).toBe('MZ-unexpected-new-version')
  expect(sha256(input.rollback)).toBe(oldRollback); expectClean(input)
})
it('handles short writes until every byte is durably staged', () => {
  const input = fixture(), previous = sha256(input.destination), write = fs.writeSync
  vi.spyOn(fs, 'writeSync').mockImplementation((fd: number, buffer: Buffer, offset: number, length: number) =>
    write(fd, buffer, offset, Math.min(2, length)))
  installRelease(input)
  expect(sha256(input.destination)).toBe(input.expectedHash)
  expect(sha256(input.rollback)).toBe(previous); expectClean(input)
})
it('restores the verified previous release if post-install checksum fails', () => {
  const input = fixture(), previous = sha256(input.destination), oldRollback = seedRollback(input)
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from: string, to: string) => {
    rename(from, to)
    if (from === input.destination + '.pending') writeFileSync(to, 'MZ-corrupted-after-rename')
  })
  expect(() => installRelease(input)).toThrow('Installed release verification failed')
  expect(sha256(input.destination)).toBe(previous); expect(sha256(input.rollback)).toBe(oldRollback)
  expectClean(input)
})
it('preserves the installed release and earlier rollback when flushing a new copy fails', () => {
  const input = fixture(), previous = sha256(input.destination), oldRollback = seedRollback(input)
  const open = fs.openSync, flush = fs.fsyncSync
  let stageFd = -1
  vi.spyOn(fs, 'openSync').mockImplementation((file: string, flags: string) => {
    const fd = open(file, flags); if (String(file) === input.destination + '.pending') stageFd = fd; return fd
  })
  vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => { if (fd === stageFd) throw Error('flush failed'); return flush(fd) })
  expect(() => installRelease(input)).toThrow('flush failed')
  expect(sha256(input.destination)).toBe(previous); expect(sha256(input.rollback)).toBe(oldRollback)
  expectClean(input)
})
