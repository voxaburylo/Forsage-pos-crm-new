import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const { assertCleanRestoreExit, assertDisposable, assertSyntheticTargets } = createRequire(import.meta.url)('../scripts/backup-restore-electron-smoke.cjs')
const report = { runtime: 'electron-application', rowsIdentical: true, previousRowsIdentical: true,
  sourceUnchanged: true, previousSourceUnchanged: true }
const result = () => ({ signal: null, status: 0, stdout: JSON.stringify(report) + '\n' })

it('accepts a complete restore report only with clean natural shutdown', () => {
  expect(assertCleanRestoreExit(result())).toEqual(report)
})
it.each([2147483651, 1, null])('does not hide a late exit failure %s behind a success report', status => {
  expect(() => assertCleanRestoreExit({ ...result(), status })).toThrow('did not exit cleanly')
})
it('rejects a killed process even with a complete report', () => {
  expect(() => assertCleanRestoreExit({ ...result(), signal: 'SIGTERM' })).toThrow('was terminated')
})
it('propagates process startup or timeout failures', () => {
  expect(() => assertCleanRestoreExit({ ...result(), error: new Error('timeout') })).toThrow('timeout')
})
it.each(['', '{}\n', JSON.stringify(report) + '\n' + JSON.stringify(report) + '\n'])('rejects missing, incomplete or duplicate reports', stdout => {
  expect(() => assertCleanRestoreExit({ ...result(), stdout })).toThrow()
})
it.each(['rowsIdentical', 'previousRowsIdentical', 'sourceUnchanged', 'previousSourceUnchanged'])('requires positive evidence of %s', field => {
  expect(() => assertCleanRestoreExit({ ...result(), stdout: JSON.stringify({ ...report, [field]: false }) })).toThrow()
})

const ownedRoots: string[] = []
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-restore-electron-'))
  ownedRoots.push(root)
  return { root, source: path.join(root, 'selected.db'), previous: path.join(root, 'previous.db'), store: path.join(root, 'synthetic-store') }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of ownedRoots.splice(0)) {
    assertDisposable(root)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('validates fresh synthetic targets without traversing the live Chromium cache, but cleanup still propagates its errors', () => {
  const { root, source, previous, store } = fixture()
  const cache = path.join(root, 'profile', 'Code Cache', 'js', 'index-dir')
  fs.mkdirSync(cache, { recursive: true })
  const vanished = path.join(cache, 'renamed.tmp')
  fs.writeFileSync(vanished, 'synthetic cache entry', { flag: 'wx' })
  const lstat = fs.lstatSync
  const missing = Object.assign(new Error('synthetic live cache rename'), { code: 'ENOENT' })
  vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: unknown[]) => {
    if (args[0] === vanished) throw missing
    return Reflect.apply(lstat, fs, args)
  }) as typeof fs.lstatSync)
  expect(assertSyntheticTargets(root, source, previous)).toBe(store)
  expect(fs.existsSync(source)).toBe(false)
  expect(fs.existsSync(previous)).toBe(false)
  expect(fs.existsSync(store)).toBe(false)
  expect(() => assertDisposable(root)).toThrow(missing)
})

it.each(['source', 'previous', 'store'] as const)('refuses an occupied %s synthetic target without touching it', target => {
  const paths = fixture()
  if (target === 'store') fs.mkdirSync(paths[target])
  else fs.writeFileSync(paths[target], 'preserve synthetic evidence', { flag: 'wx' })
  expect(() => assertSyntheticTargets(paths.root, paths.source, paths.previous)).toThrow('Synthetic target already exists')
  if (target === 'store') expect(fs.readdirSync(paths.store)).toEqual([])
  else expect(fs.readFileSync(paths[target], 'utf8')).toBe('preserve synthetic evidence')
})

it('rejects a redirected root and refuses targets other than the two exact owned backup names', () => {
  const { root, source, previous } = fixture()
  expect(() => assertSyntheticTargets(root, path.join(root, 'different.db'), previous)).toThrow()
  expect(() => assertSyntheticTargets(root, source, path.join(root, '..', 'outside.db'))).toThrow()
  vi.spyOn(fs, 'realpathSync').mockReturnValue(path.join(root, 'redirected'))
  expect(() => assertSyntheticTargets(root, source, previous)).toThrow()
  expect(() => assertDisposable(root)).toThrow()
})

it('does not accept a dangling synthetic target link or swallow a target access error', () => {
  const { root, source, previous } = fixture()
  const lstat = fs.lstatSync
  const denied = Object.assign(new Error('synthetic permission error'), { code: 'EACCES' })
  let targetError = false
  vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: unknown[]) => {
    if (args[0] === source) {
      if (targetError) throw denied
      return { isSymbolicLink: () => true, isDirectory: () => false }
    }
    return Reflect.apply(lstat, fs, args)
  }) as typeof fs.lstatSync)
  expect(() => assertSyntheticTargets(root, source, previous)).toThrow('Synthetic target already exists')
  targetError = true
  expect(() => assertSyntheticTargets(root, source, previous)).toThrow(denied)
})

it('keeps recursive redirected-child cleanup rejection strict', () => {
  const { root } = fixture()
  const child = path.join(root, 'synthetic-link')
  fs.mkdirSync(child)
  const lstat = fs.lstatSync
  vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: unknown[]) => {
    if (args[0] === child) return { isSymbolicLink: () => true, isDirectory: () => true }
    return Reflect.apply(lstat, fs, args)
  }) as typeof fs.lstatSync)
  expect(() => assertDisposable(root)).toThrow('Refuse redirected cleanup')
})
