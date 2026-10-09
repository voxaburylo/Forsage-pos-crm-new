import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { LOCAL_MIGRATIONS, LOCAL_SCHEMA_VERSION } from '../src/db/schema'
import { SUPPLIER_CATALOG_SCHEMA_SQL } from '../src/db/supplierCatalogSchema'

it('declares the actual latest migration for backup compatibility', () => {
  expect(LOCAL_SCHEMA_VERSION).toBe(Math.max(...LOCAL_MIGRATIONS.map(migration => migration.version)))
})

it('upgrades scope provenance without inventing mode for historical server copies', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE suppliers(id TEXT PRIMARY KEY); CREATE TABLE products(id TEXT PRIMARY KEY);')
    db.exec(SUPPLIER_CATALOG_SCHEMA_SQL)
    const insert = db.prepare("INSERT INTO supplier_price_imports(id,tenant_id,filename,mode,warehouse_name,remote_updated_at,created_at,updated_at) VALUES(?, 'fixture', 'price.csv', ?, ?, ?, '2026-10-01', '2026-10-01')")
    insert.run('local', 'replace', 'Main', null)
    insert.run('legacy-remote', 'add', null, '2026-10-01')
    const before = db.prepare('SELECT * FROM supplier_price_imports ORDER BY id').all()
    db.exec(LOCAL_MIGRATIONS.find(migration => migration.version === 28)!.sql)
    const after = db.prepare('SELECT * FROM supplier_price_imports ORDER BY id').all()
    expect(after.map(({ scope_known, ...original }) => original)).toEqual(before)
    expect(after.map(row => [row.id, row.scope_known])).toEqual([['legacy-remote', 0], ['local', 1]])
    expect(() => db.exec('UPDATE supplier_price_imports SET scope_known=2')).toThrow()
  } finally {
    db.close()
  }
})
