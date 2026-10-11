import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { assertClosedRestoreTarget, publishPreparedRestore } from '../src/db/publishDatabaseRestore'
import { LocalDatabase } from '../src/db/localDatabase'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

const roots: string[] = []
const previous = Buffer.from('synthetic current 101'), selected = Buffer.from('synthetic selected 98')
function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'forsage-restore-publish-'))
  roots.push(root)
  const data = path.join(root, 'data'), retainedRoot = path.join(root, 'corrupt')
  fs.mkdirSync(data)
  const live = path.join(data, 'forsage.db'), prepared = path.join(data, 'restore-' + randomUUID() + '.db.partial')
  fs.writeFileSync(live, previous); fs.writeFileSync(prepared, selected)
  return { root, data, live, prepared, retainedRoot }
}
function archives(f: ReturnType<typeof fixture>) {
  return fs.existsSync(f.retainedRoot) ? fs.readdirSync(f.retainedRoot).filter(name => name.endsWith('.db')) : []
}
function unchanged(f: ReturnType<typeof fixture>) {
  expect(fs.readFileSync(f.live)).toEqual(previous)
  expect(fs.readFileSync(f.prepared)).toEqual(selected)
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()))
    expect(path.basename(root)).toMatch(/^forsage-restore-publish-/)
    expect(fs.realpathSync(root)).toBe(root)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('keeps live data until one rename and preserves a separate verified previous version', () => {
  const f = fixture(), rename = fs.renameSync
  const calls: string[][] = []
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    calls.push([String(from), String(to)])
    expect(from).toBe(f.prepared); expect(to).toBe(f.live)
    unchanged(f)
    expect(archives(f)).toHaveLength(1)
    expect(fs.readFileSync(path.join(f.retainedRoot, archives(f)[0]))).toEqual(previous)
    return rename(from, to)
  })
  publishPreparedRestore(f.root, f.prepared)
  expect(calls).toEqual([[f.prepared, f.live]])
  expect(fs.readFileSync(f.live)).toEqual(selected)
  expect(fs.existsSync(f.prepared)).toBe(false)
  const archived = path.join(f.retainedRoot, archives(f)[0])
  expect(fs.readFileSync(archived)).toEqual(previous)
  expect(fs.statSync(archived).nlink).toBe(1)
  fs.writeFileSync(f.live, 'new work after restore')
  expect(fs.readFileSync(archived)).toEqual(previous)
})

it.each(['-wal', '-shm', '-journal'])('refuses an existing %s before staging any previous database', suffix => {
  const f = fixture(), sidecar = f.live + suffix
  fs.writeFileSync(sidecar, 'uncheckpointed work')
  expect(() => publishPreparedRestore(f.root, f.prepared)).toThrow('незавершених операцій')
  unchanged(f)
  expect(fs.readFileSync(sidecar, 'utf8')).toBe('uncheckpointed work')
  expect(fs.existsSync(f.retainedRoot)).toBe(false)
})
it.each(['-wal', '-shm', '-journal'])('refuses a candidate with %s without replacing the current file', suffix => {
  const f = fixture()
  fs.writeFileSync(f.prepared + suffix, 'not a standalone snapshot')
  expect(() => publishPreparedRestore(f.root, f.prepared)).toThrow('незавершених операцій')
  unchanged(f)
  expect(fs.existsSync(f.retainedRoot)).toBe(false)
})

it.each(['partial-copy', 'wrong-copy', 'flush', 'link', 'rename'])('preserves live data on %s failure', phase => {
  const f = fixture(), copy = fs.copyFileSync
  if (phase === 'partial-copy' || phase === 'wrong-copy') {
    vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
      expect(from).toBe(f.live)
      if (phase === 'partial-copy') {
        fs.writeFileSync(to, 'interrupted old copy')
        throw new Error('fixture copy disk full')
      }
      copy(from, to, mode)
      fs.writeFileSync(to, 'silently corrupted copy')
    })
  }
  if (phase === 'flush') vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('fixture flush failure') })
  if (phase === 'link') vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw new Error('fixture unsupported link') })
  if (phase === 'rename') vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('fixture target locked') })
  expect(() => publishPreparedRestore(f.root, f.prepared)).toThrow()
  unchanged(f)
  expect(archives(f)).toHaveLength(phase === 'rename' ? 1 : 0)
  if (phase === 'rename') expect(fs.readFileSync(path.join(f.retainedRoot, archives(f)[0]))).toEqual(previous)
  vi.restoreAllMocks()
  publishPreparedRestore(f.root, f.prepared)
  expect(fs.readFileSync(f.live)).toEqual(selected)
})

it.each(['live', 'prepared', 'archive', 'new-wal'])('refuses %s changes during preservation of the previous version', kind => {
  const f = fixture(), link = fs.linkSync
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    link(from, to)
    if (kind === 'live') fs.writeFileSync(f.live, 'concurrent later work')
    if (kind === 'prepared') fs.writeFileSync(f.prepared, 'unexpected candidate')
    if (kind === 'archive') fs.writeFileSync(to, 'unexpected archive')
    if (kind === 'new-wal') fs.writeFileSync(f.live + '-wal', 'concurrent committed work')
  })
  expect(() => publishPreparedRestore(f.root, f.prepared)).toThrow()
  expect(fs.readFileSync(f.live)).toEqual(kind === 'live' ? Buffer.from('concurrent later work') : previous)
  expect(fs.readFileSync(f.prepared)).toEqual(kind === 'prepared' ? Buffer.from('unexpected candidate') : selected)
  if (kind === 'new-wal') expect(fs.readFileSync(f.live + '-wal', 'utf8')).toBe('concurrent committed work')
})

it.each(['live', 'prepared'])('refuses a same-byte replacement of the %s file during preparation', kind => {
  const f = fixture(), link = fs.linkSync
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    link(from, to)
    const file = kind === 'live' ? f.live : f.prepared
    fs.renameSync(file, file + '.previous-identity')
    fs.writeFileSync(file, kind === 'live' ? previous : selected)
  })
  expect(() => publishPreparedRestore(f.root, f.prepared)).toThrow()
  unchanged(f)
})

it.each(['live', 'prepared'])('rejects a hard-linked %s file without changing its other name', target => {
  const f = fixture(), file = target === 'live' ? f.live : f.prepared, alias = path.join(f.root, 'alias.db')
  fs.linkSync(file, alias)
  expect(() => publishPreparedRestore(f.root, f.prepared)).toThrow('LOCAL_RESTORE_REDIRECTED_PATH')
  unchanged(f)
  expect(fs.readFileSync(alias)).toEqual(target === 'live' ? previous : selected)
})
it('rejects a redirected previous-version directory without writing outside it', () => {
  const f = fixture(), external = path.join(f.root, 'external')
  fs.mkdirSync(external)
  fs.symlinkSync(external, f.retainedRoot, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => publishPreparedRestore(f.root, f.prepared)).toThrow('LOCAL_RESTORE_REDIRECTED_PATH')
  unchanged(f)
  expect(fs.readdirSync(external)).toEqual([])
})
it('does not overwrite a coincidentally existing previous-version path', () => {
  const f = fixture(), link = fs.linkSync
  let collided = ''
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    collided = String(to)
    fs.writeFileSync(to, 'unrelated pre-existing file')
    return link(from, to)
  })
  expect(() => publishPreparedRestore(f.root, f.prepared)).toThrow()
  unchanged(f)
  expect(fs.readFileSync(collided, 'utf8')).toBe('unrelated pre-existing file')
})
it('rejects a missing current file instead of filling it from an arbitrary partial', () => {
  const f = fixture()
  fs.unlinkSync(f.live)
  expect(() => publishPreparedRestore(f.root, f.prepared)).toThrow()
  expect(fs.existsSync(f.live)).toBe(false)
  expect(fs.readFileSync(f.prepared)).toEqual(selected)
})
it('rejects a candidate outside the data directory', () => {
  const f = fixture(), foreign = path.join(f.root, path.basename(f.prepared))
  fs.copyFileSync(f.prepared, foreign)
  expect(() => publishPreparedRestore(f.root, foreign)).toThrow('LOCAL_RESTORE_INVALID_CANDIDATE_PATH')
  unchanged(f)
  expect(fs.readFileSync(foreign)).toEqual(selected)
})
it('does not report failure after a successful replacement just because cleanup is unavailable', () => {
  const f = fixture()
  vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw new Error('fixture cleanup denied') })
  publishPreparedRestore(f.root, f.prepared)
  expect(fs.readFileSync(f.live)).toEqual(selected)
  expect(fs.readFileSync(path.join(f.retainedRoot, archives(f)[0]))).toEqual(previous)
})
it('retains a replaced staging path instead of deleting another actor file', () => {
  const f = fixture(), rename = fs.renameSync
  let staged = ''
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    rename(from, to)
    staged = path.join(f.retainedRoot, archives(f)[0] + '.partial')
    rename(staged, staged + '.saved')
    fs.writeFileSync(staged, 'unowned replacement')
  })
  publishPreparedRestore(f.root, f.prepared)
  expect(fs.readFileSync(f.live)).toEqual(selected)
  expect(fs.readFileSync(staged, 'utf8')).toBe('unowned replacement')
})

it('blocks a real active WAL connection, then succeeds after clean close without losing its latest rows', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'forsage-restore-publish-'))
  roots.push(root)
  const db = LocalDatabase.open(root).database
  let backup: string
  try {
    db.exec('CREATE TABLE restore_probe(value INTEGER); INSERT INTO restore_probe VALUES(98)')
    backup = await db.backupNow()
    db.exec('UPDATE restore_probe SET value=101')
    expect(() => assertClosedRestoreTarget(root)).toThrow('незавершених операцій')
    expect(() => LocalDatabase.stageBackupForRestart(root, path.basename(backup))).toThrow('незавершених операцій')
    expect(db.prepare('SELECT value FROM restore_probe').get()).toEqual({ value: 101 })
    expect(fs.existsSync(path.join(root, 'corrupt'))).toBe(false)
  } finally { db.close() }
  const live = path.join(root, 'data', 'forsage.db')
  const before = createHash('sha256').update(fs.readFileSync(live)).digest('hex')
  LocalDatabase.stageBackupForRestart(root, path.basename(backup!))
  const retained = fs.readdirSync(path.join(root, 'corrupt')).find(name => name.endsWith('.db'))!
  expect(createHash('sha256').update(fs.readFileSync(path.join(root, 'corrupt', retained))).digest('hex')).toBe(before)
  const opened = LocalDatabase.open(root).database
  try { expect(opened.prepare('SELECT value FROM restore_probe').get()).toEqual({ value: 98 }) }
  finally { opened.close() }
})
