import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'

const { databaseFingerprint, restoreComparisonOptions } = createRequire(import.meta.url)('../scripts/backup-restore-readiness.cjs')
const connections: DatabaseSync[] = []
const open = () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE products(id TEXT PRIMARY KEY, qty REAL, price INTEGER, photo_url TEXT)')
  connections.push(db)
  return db
}
afterEach(() => { for (const db of connections.splice(0)) db.close() })

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
  db.exec("INSERT INTO schema_migrations VALUES(28, '2026-10-02T10:00:00Z')")
  expect(() => restoreComparisonOptions(db, 26, 28)).toThrow('Restore comparison requires a reviewed migration')
})
