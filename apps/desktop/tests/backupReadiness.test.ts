import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { LOCAL_MIGRATIONS } from '../src/db/schema'

const { databaseFingerprint, restoreComparisonOptions, assertStandaloneBackup } = createRequire(import.meta.url)('../scripts/backup-restore-readiness.cjs')
const connections: DatabaseSync[] = []
const open = () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE products(id TEXT PRIMARY KEY, qty REAL, price INTEGER, photo_url TEXT)')
  connections.push(db)
  return db
}
const roots: string[] = []
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()))
    expect(path.basename(root)).toMatch(/^forsage-standalone-check-/)
    expect(realpathSync(root)).toBe(root)
    rmSync(root, { recursive: true, force: true })
  }
})
function standaloneFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'forsage-standalone-check-'))
  roots.push(root)
  const backup = path.join(root, 'selected.db')
  writeFileSync(backup, 'fixture')
  return { root, backup }
}
it('requires an explicit absolute standalone file for both restore inputs', () => {
  const { backup, root } = standaloneFixture()
  expect(assertStandaloneBackup(backup)).toBe(realpathSync(backup))
  for (const value of ['', 'relative.db', undefined]) expect(() => assertStandaloneBackup(value)).toThrow('absolute path')
  expect(() => assertStandaloneBackup(root)).toThrow('regular file')
})
it('refuses a working data/forsage.db even when it exists', () => {
  const { root } = standaloneFixture()
  mkdirSync(path.join(root, 'data'))
  const live = path.join(root, 'data', 'forsage.db')
  writeFileSync(live, 'fixture')
  expect(() => assertStandaloneBackup(live)).toThrow('Never use the live database')
})
it.each(['-wal', '-shm', '-journal'])('refuses a backup with %s sidecar', suffix => {
  const { backup } = standaloneFixture()
  writeFileSync(backup + suffix, '')
  expect(() => assertStandaloneBackup(backup)).toThrow('without SQLite sidecars')
})

it('compares every row independently of physical insertion order', () => {
  const left = open(), right = open()
  for (const id of ['a', 'b']) left.prepare('INSERT INTO products VALUES(?,98,1000,NULL)').run(id)
  for (const id of ['b', 'a']) right.prepare('INSERT INTO products VALUES(?,98,1000,NULL)').run(id)
  expect(databaseFingerprint(left)).toEqual(databaseFingerprint(right))
})
it.each(['qty', 'price'])('detects a changed %s with identical row counts', column => {
  const db = open()
  db.exec("INSERT INTO products VALUES('a',98,1000,NULL)")
  const before = databaseFingerprint(db)
  db.exec('UPDATE products SET ' + column + '=' + column + '+1')
  expect(databaseFingerprint(db)).not.toEqual(before)
})
it('distinguishes SQL null, text, blob and large integer without exposing values', () => {
  const db = open()
  db.exec('CREATE TABLE probe(value)')
  const insert = db.prepare('INSERT INTO probe VALUES(?)')
  const hashes = []
  for (const value of [null, 'null', Buffer.from('null'), 9223372036854775807n]) {
    db.exec('DELETE FROM probe'); insert.run(value)
    hashes.push(databaseFingerprint(db).probe.hash)
  }
  expect(new Set(hashes).size).toBe(4)
})
it('normalizes only explicitly verified relocated product photos', () => {
  const left = open(), right = open()
  left.exec("INSERT INTO products VALUES('a',98,1000,'file:///old.jpg')")
  right.exec("INSERT INTO products VALUES('a',98,1000,'file:///restored.jpg')")
  expect(databaseFingerprint(left)).not.toEqual(databaseFingerprint(right))
  const photos = new Map([['file:///old.jpg', 'verified-sha'], ['file:///restored.jpg', 'verified-sha']])
  expect(databaseFingerprint(left, photos)).toEqual(databaseFingerprint(right, photos))
})

function migrationFixture() {
  const db = open()
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT);
    INSERT INTO schema_migrations VALUES(26, '2026-09-01T10:00:00Z');
    CREATE TABLE customer_returns(id TEXT PRIMARY KEY, refund_kopecks INTEGER);
    INSERT INTO customer_returns VALUES('original-return', 10000);
    INSERT INTO products VALUES('original-product', 98, 1000, NULL);`)
  return db
}
function migrateRefundShift(db: DatabaseSync) {
  db.exec(`ALTER TABLE customer_returns ADD COLUMN shift_id TEXT;
    INSERT INTO schema_migrations VALUES(27, '2026-10-02T10:00:00Z')`)
}

it('compares all original values while accepting the explicitly additive refund-shift migration', () => {
  const db = migrationFixture(), before = databaseFingerprint(db)
  migrateRefundShift(db)
  expect(databaseFingerprint(db)).not.toEqual(before)
  expect(databaseFingerprint(db, new Map(), restoreComparisonOptions(db, 26, 27))).toEqual(before)
})

it.each([
  'UPDATE products SET qty=99',
  'UPDATE products SET price=1001',
  'UPDATE customer_returns SET refund_kopecks=9999',
  'DELETE FROM customer_returns',
  "UPDATE schema_migrations SET applied_at='changed' WHERE version=26",
])('does not hide changed original data during a schema upgrade: %s', sql => {
  const db = migrationFixture(), before = databaseFingerprint(db)
  migrateRefundShift(db)
  db.exec(sql)
  expect(databaseFingerprint(db, new Map(), restoreComparisonOptions(db, 26, 27))).not.toEqual(before)
})

it('rejects guessed historical refund shifts instead of excluding the new column blindly', () => {
  const db = migrationFixture()
  migrateRefundShift(db)
  db.exec("UPDATE customer_returns SET shift_id='invented-shift'")
  expect(() => restoreComparisonOptions(db, 26, 27)).toThrow('Historical refund shifts must remain NULL')
})

it('compares every column and migration record when there is no upgrade', () => {
  const db = migrationFixture()
  migrateRefundShift(db)
  const before = databaseFingerprint(db)
  expect(databaseFingerprint(db, new Map(), restoreComparisonOptions(db, 27, 27))).toEqual(before)
  db.exec("UPDATE customer_returns SET shift_id='changed'")
  expect(databaseFingerprint(db, new Map(), restoreComparisonOptions(db, 27, 27))).not.toEqual(before)
})

it('fails closed for unreviewed migrations and incorrect restored schema versions', () => {
  const db = migrationFixture()
  expect(() => restoreComparisonOptions(db, 26, 27)).toThrow('Restored schema version differs')
  migrateRefundShift(db)
  db.exec("INSERT INTO schema_migrations VALUES(29, '2026-10-02T10:00:00Z')")
  expect(() => restoreComparisonOptions(db, 28, 29)).toThrow('Restore comparison requires a reviewed migration')
})

function importScopeFixture() {
  const db = migrationFixture()
  migrateRefundShift(db)
  db.exec("CREATE TABLE supplier_price_imports(id TEXT PRIMARY KEY,mode TEXT,warehouse_name TEXT,remote_updated_at TEXT); INSERT INTO supplier_price_imports VALUES('local','replace','Main',NULL),('remote','add',NULL,'2026-10-01');")
  return db
}
function migrateImportScope(db: DatabaseSync) {
  db.exec(LOCAL_MIGRATIONS.find(migration => migration.version === 28)!.sql)
  db.exec("INSERT INTO schema_migrations VALUES(28, '2026-10-07T18:00:00Z')")
}

it('verifies 27 to 28 while retaining real refund shifts and every original import field', () => {
  const db = importScopeFixture()
  db.exec("UPDATE customer_returns SET shift_id='real-shift'")
  const before = databaseFingerprint(db)
  migrateImportScope(db)
  expect(databaseFingerprint(db, new Map(), restoreComparisonOptions(db, 27, 28))).toEqual(before)
})

it('reviews both migrations when restoring 26 directly to 28', () => {
  const db = importScopeFixture()
  db.exec('ALTER TABLE customer_returns DROP COLUMN shift_id; DELETE FROM schema_migrations WHERE version=27')
  const before = databaseFingerprint(db)
  migrateRefundShift(db)
  migrateImportScope(db)
  expect(databaseFingerprint(db, new Map(), restoreComparisonOptions(db, 26, 28))).toEqual(before)
})

it.each(['local', 'remote'])('rejects invented scope evidence for %s history', id => {
  const db = importScopeFixture()
  migrateImportScope(db)
  db.prepare('UPDATE supplier_price_imports SET scope_known=1-scope_known WHERE id=?').run(id)
  expect(() => restoreComparisonOptions(db, 27, 28)).toThrow('Historical import scope provenance differs')
})

it.each([
  "UPDATE supplier_price_imports SET mode='add' WHERE id='local'",
  "UPDATE supplier_price_imports SET warehouse_name='Other' WHERE id='local'",
  "DELETE FROM supplier_price_imports WHERE id='local'",
  "UPDATE customer_returns SET shift_id='changed'",
])('does not mask changed old values during 27 to 28 upgrade: %s', sql => {
  const db = importScopeFixture(), before = databaseFingerprint(db)
  migrateImportScope(db)
  db.exec(sql)
  expect(databaseFingerprint(db, new Map(), restoreComparisonOptions(db, 27, 28))).not.toEqual(before)
})
