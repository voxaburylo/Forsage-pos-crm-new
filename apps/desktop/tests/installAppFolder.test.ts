import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resolvePortableExecutable } from '../src/updates/installedPortable'

// Рішення власника 22.11.2026: головна каса — з постійної теки (швидкий старт, один дозвіл брандмауера).
const require = createRequire(import.meta.url)
const { installAppFolder } = require('../scripts/install-app-folder.cjs') as {
  installAppFolder: (input: Record<string, unknown>) => { alreadyInstalled: boolean; previousDir: string | null; files: number }
}

let root: string
const build = (dir: string, version: string) => {
  mkdirSync(path.join(dir, 'resources'), { recursive: true })
  writeFileSync(path.join(dir, 'Forsage.exe'), 'MZ' + version)
  writeFileSync(path.join(dir, 'resources', 'app.asar'), 'asar ' + version)
}
const paths = () => ({
  appDir: path.join(root, 'Forsage', 'app'),
  previousDir: path.join(root, 'Forsage', 'old-builds', 'app-before-update'),
  portableExecutable: path.join(root, 'release', 'Forsage-0.1.0-portable.exe'),
})

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-app-folder-'))
  mkdirSync(path.join(root, 'release'))
  writeFileSync(paths().portableExecutable, 'MZportable')
})
afterEach(() => {
  if (path.dirname(path.resolve(root)) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-app-folder-')) rmSync(root, { recursive: true, force: true })
})

it('installs the build into a fixed folder, keeps the previous one for rollback and points to the portable EXE', () => {
  const closedChecks: number[] = []
  build(path.join(root, 'v1'), '1')
  const first = installAppFolder({ sourceDir: path.join(root, 'v1'), ...paths(), checkClosed: () => closedChecks.push(1) })
  expect(first).toMatchObject({ alreadyInstalled: false, previousDir: null, files: 2 })
  expect(readFileSync(path.join(paths().appDir, 'Forsage.exe'), 'utf8')).toBe('MZ1')
  expect(resolvePortableExecutable({}, path.join(paths().appDir, 'Forsage.exe'))).toBe(paths().portableExecutable)

  build(path.join(root, 'v2'), '2')
  const second = installAppFolder({ sourceDir: path.join(root, 'v2'), ...paths(), checkClosed: () => closedChecks.push(2) })
  expect(second.previousDir).toBe(paths().previousDir)
  expect(readFileSync(path.join(paths().appDir, 'Forsage.exe'), 'utf8')).toBe('MZ2')
  expect(readFileSync(path.join(paths().previousDir, 'Forsage.exe'), 'utf8')).toBe('MZ1')
  expect(existsSync(paths().appDir + '.pending')).toBe(false)
  expect(closedChecks).toEqual([1, 1, 2, 2])

  expect(installAppFolder({ sourceDir: path.join(root, 'v2'), ...paths(), checkClosed: () => undefined }).alreadyInstalled).toBe(true)
})

it('changes nothing while the till is open', () => {
  build(path.join(root, 'v1'), '1')
  expect(() => installAppFolder({ sourceDir: path.join(root, 'v1'), ...paths(), checkClosed: () => { throw new Error('Закрийте Форсаж') } })).toThrow('Закрийте Форсаж')
  expect(existsSync(paths().appDir)).toBe(false)
  expect(existsSync(paths().appDir + '.pending')).toBe(false)
})

it('refuses an incomplete build', () => {
  mkdirSync(path.join(root, 'broken'))
  writeFileSync(path.join(root, 'broken', 'Forsage.exe'), 'MZ')
  expect(() => installAppFolder({ sourceDir: path.join(root, 'broken'), ...paths(), checkClosed: () => undefined })).toThrow('incomplete')
})

it('the running portable EXE wins; a bad pointer is ignored', () => {
  expect(resolvePortableExecutable({ PORTABLE_EXECUTABLE_FILE: 'C:\\x\\Forsage.exe' }, 'C:\\app\\Forsage.exe')).toBe('C:\\x\\Forsage.exe')
  expect(resolvePortableExecutable({}, 'C:\\app\\Forsage.exe', () => '{"portableExecutable":"relative.exe"}')).toBeUndefined()
  expect(resolvePortableExecutable({}, 'C:\\app\\Forsage.exe', () => 'not json')).toBeUndefined()
})
