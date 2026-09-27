import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, symlinkSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { LocalDatabase, MAX_CACHED_STATEMENTS } from '../src/db/localDatabase'
import { createVerifiedBackup } from '../src/db/verifiedBackup'
import { readBuildInfo } from '../src/diagnostics/buildInfo'
const { fingerprint, writeBuildInfo } = createRequire(import.meta.url)('../scripts/build-info.cjs')
const { verifyBuild } = createRequire(import.meta.url)('../scripts/verify-build.cjs')
const { cleanBuild } = createRequire(import.meta.url)('../scripts/clean-build.cjs')
const roots: string[] = []
const databases: LocalDatabase[] = []
function root() { const value = mkdtempSync(path.join(tmpdir(), 'forsage-foundation-')); roots.push(value); return value }
function database() { const db = new LocalDatabase(root()); databases.push(db); return db }
it('cleans only compiler output before a release, preserving release and data folders', () => {
  const project = root()
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({ main: 'dist/main.js', build: { appId: 'ua.forsage.crm' } }))
  for (const name of ['dist', 'release', 'data']) { mkdirSync(path.join(project, name)); writeFileSync(path.join(project, name, 'keep.txt'), name) }
  cleanBuild(project)
  expect(existsSync(path.join(project, 'dist'))).toBe(false)
  expect(readFileSync(path.join(project, 'release/keep.txt'), 'utf8')).toBe('release')
  expect(readFileSync(path.join(project, 'data/keep.txt'), 'utf8')).toBe('data')
  symlinkSync(path.join(project, 'data'), path.join(project, 'dist'), 'junction')
  expect(() => cleanBuild(project)).toThrow('redirected')
  expect(readFileSync(path.join(project, 'data/keep.txt'), 'utf8')).toBe('data')
  rmSync(path.join(project, 'dist'))
  writeFileSync(path.join(project, 'package.json'), '{}')
  expect(() => cleanBuild(project)).toThrow('unrelated')
})
afterEach(async () => {
  for (const db of databases.splice(0)) { await db.waitForBackup().catch(() => {}); db.close() }
  for (const value of roots.splice(0)) if (path.dirname(value) === tmpdir() && path.basename(value).startsWith('forsage-foundation-')) rmSync(value, { recursive: true, force: true })
})
it('identifies renderer-only changes and never includes its own generated metadata', () => {
  const project = root(), dist = path.join(project, 'dist')
  mkdirSync(path.join(dist, 'renderer'), { recursive: true })
  writeFileSync(path.join(project, 'package.json'), '{"version":"0.1.0"}')
  for (const name of ['main.js', 'preload.js', 'renderer/index.html']) writeFileSync(path.join(dist, name), name)
  const first = writeBuildInfo(project, new Date('2026-09-23T12:00:00Z'))
  expect(readBuildInfo(dist)?.releaseId).toBe(first.releaseId)
  expect(verifyBuild(project).releaseId).toBe(first.releaseId)
  expect(fingerprint(dist, path.join(project, 'package.json')).contentHash).toBe(first.contentHash)
  writeFileSync(path.join(dist, 'renderer/index.html'), 'changed UI')
  expect(() => verifyBuild(project)).toThrow('Build identity mismatch')
  expect(writeBuildInfo(project).contentHash).not.toBe(first.contentHash)
  writeFileSync(path.join(dist, 'build-info.json'), '{"format":1,"version":null}')
  expect(readBuildInfo(dist)).toBeNull()
})
it('rejects missing renderer assets even when an incomplete build was stamped', () => {
  const project = root(), dist = path.join(project, 'dist')
  mkdirSync(path.join(dist, 'renderer'), { recursive: true })
  writeFileSync(path.join(project, 'package.json'), '{"version":"0.1.0"}')
  for (const name of ['main.js', 'preload.js']) writeFileSync(path.join(dist, name), name)
  writeFileSync(path.join(dist, 'renderer/index.html'), '<script src="./assets/missing.js"></script>')
  writeBuildInfo(project)
  expect(() => verifyBuild(project)).toThrow('Renderer asset is missing')
})
it('rolls back a nested failure even when its caller handles the error', () => {
  const db = database(); db.exec('CREATE TABLE probe(value INTEGER)')
  db.transaction(() => {
    db.exec('INSERT INTO probe VALUES(1)')
    expect(() => db.transaction(() => { db.exec('INSERT INTO probe VALUES(2)'); throw Error('inner') })).toThrow('inner')
    db.exec('INSERT INTO probe VALUES(3)')
  })
  expect(db.prepare('SELECT value FROM probe').all()).toEqual([{ value: 1 }, { value: 3 }])
})
it('rejects async transactions before executing their body and rejects returned promises', () => {
  const db = database(); db.exec('CREATE TABLE probe(value INTEGER)')
  expect(() => db.transaction(async () => { db.exec('INSERT INTO probe VALUES(1)') })).toThrow('LOCAL_ASYNC_TRANSACTION_FORBIDDEN')
  expect(() => db.transaction(() => { db.exec('INSERT INTO probe VALUES(2)'); return Promise.resolve(1) })).toThrow('LOCAL_ASYNC_TRANSACTION_FORBIDDEN')
  expect(db.prepare('SELECT count(*) n FROM probe').get()).toEqual({ n: 0 })
})
it('bounds cached statements while evicted live statements remain usable', () => {
  const db = database(), old = db.prepare('SELECT 99 n')
  for (let n = 0; n < MAX_CACHED_STATEMENTS + 50; n++) db.prepare(`SELECT ${n} n`).get()
  expect((db as unknown as { statements: Map<string, unknown> }).statements.size).toBe(MAX_CACHED_STATEMENTS)
  expect(old.get()).toEqual({ n: 99 })
})
it('refuses a structurally valid backup with missing business tables before replacing anything', async () => {
  const db = database(), backup = await db.backupNow()
  const copy = new DatabaseSync(backup); copy.exec('DROP TABLE supplier_payments'); copy.close()
  const before = readFileSync(db.databasePath)
  expect(() => LocalDatabase.assertBackupIsUsable(backup)).toThrow('LOCAL_BACKUP_MISSING_TABLE')
  expect(readFileSync(db.databasePath)).toEqual(before)
})
it('refuses broken references and refuses a backup onto the source itself', async () => {
  const db = database()
  db.exec('PRAGMA foreign_keys=OFF; CREATE TABLE backup_parent(id INTEGER PRIMARY KEY); CREATE TABLE backup_child(id INTEGER REFERENCES backup_parent(id)); INSERT INTO backup_child VALUES(123)')
  await expect(db.backupNow()).rejects.toThrow('LOCAL_BACKUP_BROKEN_REFERENCES')
  expect(db.listBackups()).toHaveLength(0)
  await expect(createVerifiedBackup(db.databasePath, db.databasePath)).rejects.toThrow('LOCAL_BACKUP_SAME_FILE')
})
it('rejects aliases of the live database before the backup worker can write', async () => {
  const db = database(), directory = root(), hardLink = path.join(directory, 'alias.db')
  linkSync(db.databasePath, hardLink)
  await expect(createVerifiedBackup(db.databasePath, hardLink)).rejects.toThrow('LOCAL_BACKUP_SAME_FILE')
  const junction = path.join(directory, 'alias-directory')
  symlinkSync(path.dirname(db.databasePath), junction, 'junction')
  await expect(createVerifiedBackup(db.databasePath, path.join(junction, path.basename(db.databasePath)))).rejects.toThrow('LOCAL_BACKUP_SAME_FILE')
  rmSync(junction)
  expect((db.prepare('PRAGMA quick_check').get() as any).quick_check).toBe('ok')
})
