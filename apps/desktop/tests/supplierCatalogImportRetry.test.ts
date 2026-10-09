import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalSupplierCatalogRepository } from '../src/repositories/supplierCatalogRepository'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'

let root: string, db: LocalDatabase, repo: LocalSupplierCatalogRepository
const at = '2026-10-08T13:00:00.000Z'
const rows = [{ source_row: 1, sku: 'A', name: 'Fixture', qty: '0.125', price_kopecks: 1200 }]
const options = (extra: Record<string, unknown> = {}): any => ({
  supplier_id: 'supplier', mode: 'add', operation_id: 'attempt-1', user_id: 'cashier', ...extra,
})
const snapshot = () => Object.fromEntries(['supplier_price_items', 'supplier_price_imports', 'sync_outbox', 'products', 'suppliers', 'app_meta']
  .map(table => [table, db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]))
const key = 'mutation:supplier-import:' + tenant + ':cashier:attempt-1'
const resolve = (id = 'attempt-1', user = 'cashier') => (repo as any).resolveImport(id, user, tenant)
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-import-retry-'))
  db = new LocalDatabase(root); repo = new LocalSupplierCatalogRepository(db)
  db.prepare('INSERT INTO suppliers(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('supplier', tenant, 'Fixture', at, at)
  db.prepare('INSERT INTO products(id,tenant_id,sku,name,qty_on_hand,created_at,updated_at) VALUES(?,?,?,?,7,?,?)')
    .run('product', tenant, 'P', 'Stock', at, at)
})
afterEach(() => {
  db.close()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-import-retry-'))
    rmSync(root, { recursive: true, force: true })
})
it.each(['add', 'replace'] as const)('replays %s after restart without another item/history/event write', mode => {
  const first = repo.importRows('file.csv', rows, options({ mode }))
  const before = snapshot()
  db.close(); db = new LocalDatabase(root); repo = new LocalSupplierCatalogRepository(db)
  expect(repo.importRows('file.csv', rows, options({ mode }))).toEqual(first)
  expect(snapshot()).toEqual(before)
})
it('does not rewind later edits when an old successful import is retried', () => {
  const first = repo.importRows('file.csv', rows, options())
  const item = repo.list().data[0]
  repo.update(item.id, { qty: '9', price_kopecks: 2000 })
  const before = snapshot()
  expect(repo.importRows('file.csv', rows, options())).toEqual(first)
  expect(snapshot()).toEqual(before)
})
it('confirmed new attempts remain separate intentional imports', () => {
  const first = repo.importRows('file.csv', rows, options())
  const second = repo.importRows('file.csv', rows, options({ operation_id: 'attempt-2' }))
  expect(first.importId).not.toBe(second.importId)
  expect(repo.list().data[0].qty).toBe('0.25')
})
it.each([
  ['quantity', { rows: [{ ...rows[0], qty: '2' }] }],
  ['price', { rows: [{ ...rows[0], price_kopecks: 99 }] }],
  ['filename', { filename: 'different.csv' }],
  ['mode', { mode: 'replace' }],
  ['warehouse', { warehouse_name: 'different' }],
  ['supplier', { supplier_id: null }],
] as const)('rejects changed %s under a committed attempt', (_label, change) => {
  repo.importRows('file.csv', rows, options())
  const before = snapshot(), c = change as any
  expect(() => repo.importRows(c.filename ?? 'file.csv', c.rows ?? rows,
    options({ ...change, rows: undefined, filename: undefined }))).toThrow(/Повтор|інші/)
  expect(snapshot()).toEqual(before)
})
it('returns committed result without requiring the old supplier to remain active', () => {
  const first = repo.importRows('file.csv', rows, options())
  db.prepare('UPDATE suppliers SET deleted_at=?,is_active=0 WHERE id=?').run(at, 'supplier')
  const before = snapshot()
  expect(repo.importRows('file.csv', rows, options())).toEqual(first)
  expect(resolve()).toEqual({ status: 'committed', result: first })
  expect(snapshot()).toEqual(before)
})
it('atomically fences a not-committed attempt against a delayed request', () => {
  const before = snapshot()
  expect(resolve()).toEqual({ status: 'not_committed' })
  const fenced = snapshot()
  expect(resolve()).toEqual({ status: 'not_committed' })
  expect(snapshot()).toEqual(fenced)
  expect(() => repo.importRows('file.csv', rows, options())).toThrow(/закрито/)
  expect(snapshot()).toEqual(fenced)
  expect(fenced.products).toEqual(before.products)
  expect(fenced.supplier_price_imports).toEqual(before.supplier_price_imports)
  repo.importRows('file.csv', rows, options({ operation_id: 'attempt-2' }))
  expect(repo.list().data[0].qty).toBe('0.125')
})
it('a different worker cannot retrieve another workers receipt', () => {
  repo.importRows('file.csv', rows, options())
  expect(resolve('attempt-1', 'manager')).toEqual({ status: 'not_committed' })
  expect(resolve().status).toBe('committed')
})
it.each(['', ' ', 'bad:id', 'x'.repeat(201), 25, null])('rejects invalid operation identifier %s before write', id => {
  const before = snapshot()
  expect(() => repo.importRows('file.csv', rows, options({ operation_id: id }))).toThrow()
  expect(snapshot()).toEqual(before)
})
it.each(['', ' ', undefined, null])('requires an actor for identified attempts: %s', user => {
  const before = snapshot()
  expect(() => repo.importRows('file.csv', rows, options({ user_id: user }))).toThrow()
  expect(snapshot()).toEqual(before)
})
it.each([
  "SELECT RAISE(IGNORE);",
  "SELECT RAISE(ABORT, 'injected');",
])('rolls back the entire import when receipt insert fails: %s', body => {
  db.exec("CREATE TRIGGER fault BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'mutation:supplier-import:%' BEGIN "+body+" END;")
  const before = snapshot()
  expect(() => repo.importRows('file.csv', rows, options())).toThrow()
  expect(snapshot()).toEqual(before)
})
it.each([
  "UPDATE supplier_price_items SET qty=900;",
  "UPDATE supplier_price_imports SET filename='changed';",
  "UPDATE sync_outbox SET payload_json='{}';",
  "UPDATE products SET qty_on_hand=0;",
  "UPDATE app_meta SET value_json='{}' WHERE key=NEW.key;",
])('rejects late side effects after saving the receipt: %s', body => {
  db.exec("CREATE TRIGGER fault AFTER INSERT ON app_meta WHEN NEW.key LIKE 'mutation:supplier-import:%' BEGIN "+body+" END;")
  const before = snapshot()
  expect(() => repo.importRows('file.csv', rows, options())).toThrow()
  expect(snapshot()).toEqual(before)
})
it.each(['{}', 'not json', '{"fingerprint":"bad","result":{"success":true,"importId":"fake"}}', '{"cancelled":true,"extra":"bad"}'])
('does not interpret damaged receipts as an absent operation: %s', value => {
  db.prepare('INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?)').run(key, value, at)
  const before = snapshot()
  expect(() => repo.importRows('file.csv', rows, options())).toThrow()
  expect(() => resolve()).toThrow()
  expect(snapshot()).toEqual(before)
})
it.each(["SELECT RAISE(IGNORE);", "UPDATE products SET qty_on_hand=0;"])
('does not report not-committed if fencing fails or changes stock: %s', body => {
  const phase = body.includes('IGNORE') ? 'BEFORE' : 'AFTER'
  db.exec("CREATE TRIGGER fault "+phase+" INSERT ON app_meta WHEN NEW.key LIKE 'mutation:supplier-import:%' BEGIN "+body+" END;")
  const before = snapshot()
  expect(() => resolve()).toThrow()
  expect(snapshot()).toEqual(before)
})
it('failed validation leaves no receipt and allows a corrected attempt', () => {
  const before = snapshot()
  expect(() => repo.importRows('file.csv', [{ ...rows[0], qty: 'wrong' }], options())).toThrow()
  expect(snapshot()).toEqual(before)
  expect(repo.importRows('file.csv', rows, options()).success).toBe(true)
})
