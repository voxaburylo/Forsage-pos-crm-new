import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { writeBuildInfo } = require('../scripts/build-info.cjs')
const { verifyPackage } = require('../scripts/verify-package.cjs')
const builderRequire = createRequire(require.resolve('electron-builder'))
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'))
const asar = libraryRequire('@electron/asar')
const roots: string[] = []

async function fixture(includeWorkers = true, includeSyncWorker = true) {
  const root = mkdtempSync(path.join(tmpdir(), 'forsage-package-test-'))
  roots.push(root)
  const project = path.join(root, 'project'), dist = path.join(project, 'dist')
  mkdirSync(path.join(dist, 'renderer'), { recursive: true })
  mkdirSync(path.join(dist, 'repositories'))
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'desktop', version: '0.1.0', main: 'dist/main.js' }))
  for (const file of ['main.js', 'preload.js', 'renderer/index.html', ...(includeWorkers
    ? ['repositories/supplyInvoiceWorker.js', 'repositories/catalogAgentWorker.js',
      ...(includeSyncWorker ? ['repositories/syncPullWorkerEntry.js'] : [])] : [])]) {
    writeFileSync(path.join(dist, file), 'fixture ' + file)
  }
  const info = writeBuildInfo(project, new Date('2026-10-02T10:00:00Z'))
  const archive = path.join(root, 'app.asar')
  await asar.createPackage(project, archive)
  return { project, dist, archive, info }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-package-test-')) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

it('accepts only the complete package of the selected verified build', async () => {
  const f = await fixture(), before = readFileSync(f.archive)
  expect(verifyPackage(f.archive, f.project)).toEqual(f.info)
  expect(readFileSync(f.archive)).toEqual(before)
})

it('rejects an internally valid old package after the renderer was rebuilt', async () => {
  const f = await fixture()
  writeFileSync(path.join(f.dist, 'renderer/index.html'), 'new renderer')
  writeBuildInfo(f.project, new Date('2026-10-02T11:00:00Z'))
  expect(() => verifyPackage(f.archive, f.project)).toThrow('Packaged release does not match the selected build')
})

it('rejects a previous release stamp even if the compiled bytes have not changed', async () => {
  const f = await fixture()
  writeBuildInfo(f.project, new Date('2026-10-02T11:00:00Z'))
  expect(() => verifyPackage(f.archive, f.project)).toThrow('Packaged release does not match the selected build')
})

it('does not accept a stale package when the selected build itself was modified', async () => {
  const f = await fixture()
  writeFileSync(path.join(f.dist, 'preload.js'), 'unstamped change')
  expect(() => verifyPackage(f.archive, f.project)).toThrow('Build identity mismatch')
})

it('rejects a matching package that omitted the background copy worker', async () => {
  const f = await fixture(true, false)
  expect(() => verifyPackage(f.archive, f.project)).toThrow('Packaged worker missing: repositories/syncPullWorkerEntry.js')
})

it('still rejects a matching package without its receiving workers', async () => {
  const f = await fixture(false)
  expect(() => verifyPackage(f.archive, f.project)).toThrow('Packaged worker missing')
})
