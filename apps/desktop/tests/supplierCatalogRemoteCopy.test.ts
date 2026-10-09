import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalSupplierCatalogRepository } from '../src/repositories/supplierCatalogRepository'
import { LocalBootstrapRepository } from '../src/repositories/bootstrapRepository'
import { LocalSyncRepository } from '../src/repositories/syncRepository'
import { createPullChangeChunks } from '../src/repositories/syncPullPlanner'

let root: string, db: LocalDatabase, catalog: LocalSupplierCatalogRepository
const at = '2026-10-08T10:00:00.000Z', later = '2026-10-08T11:00:00.000Z'
const item = (id = 'item', fields = {}) => ({ id, name: 'Fixture', sku: 'SKU', price_kopecks: 1200, qty: '0.125', updated_at: at, ...fields })
const header = (id = 'history', fields = {}) => ({ id, filename: 'price.csv', total_rows: 3, processed_rows: 3, status: 'completed', mode: 'replace', warehouse_name: 'Main', updated_at: at, ...fields })
const table = (kind: string) => kind === 'item' ? 'supplier_price_items' : 'supplier_price_imports'
const record = (kind: string, fields = {}) => kind === 'item' ? item('item', fields) : header('history', fields)
const apply = (kind: string, value: any) => kind === 'item' ? catalog.upsertRemoteItem(value, tenant, later) : catalog.upsertRemoteImport(value, tenant, later)
const snapshot = () => ['supplier_price_items', 'supplier_price_imports', 'products', 'sync_outbox', 'sync_state', 'app_meta']
  .map(name => db.prepare('SELECT * FROM ' + name + ' ORDER BY rowid').all())
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-catalog-copy-'))
  db = new LocalDatabase(root); catalog = new LocalSupplierCatalogRepository(db)
  db.prepare('INSERT INTO products(id,tenant_id,sku,name,qty_on_hand,created_at,updated_at) VALUES(?,?,?,?,7,?,?)')
    .run('stock', tenant, 'STOCK', 'Stock fixture', at, at)
})
afterEach(() => {
  db.close()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-catalog-copy-')) rmSync(root, { recursive: true, force: true })
})

it.each(['item', 'import'])('rolls back a silently skipped %s insert', kind => {
  db.exec('CREATE TRIGGER fault BEFORE INSERT ON ' + table(kind) + ' BEGIN SELECT RAISE(IGNORE); END;')
  const before = snapshot()
  expect(() => apply(kind, record(kind))).toThrow()
  expect(snapshot()).toEqual(before)
})
it.each(['item', 'import'].flatMap(kind => ['INSERT', 'UPDATE'].map(op => ({ kind, op }))))('rolls back altered $kind $op data and unexpected stock writes', ({ kind, op }) => {
  if (op === 'UPDATE') apply(kind, record(kind))
  db.exec('CREATE TRIGGER fault AFTER ' + op + ' ON ' + table(kind) + " BEGIN UPDATE products SET qty_on_hand=0 WHERE id='stock'; END;")
  const before = snapshot()
  expect(() => apply(kind, record(kind, { updated_at: later }))).toThrow()
  expect(snapshot()).toEqual(before)
})
it.each(['item', 'import'])('keeps the newer clean %s when an older copy arrives', kind => {
  apply(kind, record(kind, { updated_at: later }))
  const before = snapshot()
  expect(apply(kind, record(kind, { name: 'Old', filename: 'old.csv' }))).toBe(false)
  expect(snapshot()).toEqual(before)
})
it.each(['item', 'import'])('orders %s versions within the same millisecond', kind => {
  apply(kind, record(kind, { updated_at: '2026-10-08T10:00:00.000900Z' }))
  const before = snapshot()
  expect(apply(kind, record(kind, { updated_at: '2026-10-08T10:00:00.000100+00:00' }))).toBe(false)
  expect(snapshot()).toEqual(before)
})
it.each(['item', 'import'])('rejects changed %s content under the same explicit version', kind => {
  apply(kind, record(kind))
  const before = snapshot()
  expect(() => apply(kind, record(kind, { name: 'Different', filename: 'different.csv' }))).toThrow()
  expect(snapshot()).toEqual(before)
})
it.each(['item', 'import'])('protects acknowledged local %s edits whose remote version is older', kind => {
  apply(kind, record(kind))
  db.prepare('UPDATE ' + table(kind) + ' SET updated_at=? WHERE id=?').run(later, kind === 'item' ? 'item' : 'history')
  const before = snapshot()
  expect(apply(kind, record(kind, { name: 'Old', filename: 'old.csv' }))).toBe(false)
  expect(snapshot()).toEqual(before)
})
it.each(['item', 'import'])('does not revive an archived %s when a legacy copy omits deleted_at', kind => {
  apply(kind, record(kind, { deleted_at: at }))
  apply(kind, record(kind, { updated_at: later }))
  expect(db.prepare('SELECT deleted_at FROM ' + table(kind)).get()).toEqual({ deleted_at: at })
})
it.each(['item', 'import'])('allows an explicit newer restore of a %s but not an older one', kind => {
  apply(kind, record(kind, { deleted_at: at }))
  expect(apply(kind, record(kind, { updated_at: later, deleted_at: null }))).toBe(true)
  const before = snapshot()
  expect(apply(kind, record(kind, { deleted_at: at }))).toBe(false)
  expect(snapshot()).toEqual(before)
})
it.each([undefined, null, {}, [], { id: '' }, { id: ' ' }, { id: 42 }, { id: {} }])('does not silently ignore malformed copy identity: %j', value => {
  for (const kind of ['item', 'import']) {
    const before = snapshot()
    expect(() => apply(kind, value)).toThrow()
    expect(snapshot()).toEqual(before)
  }
})
it.each(['', 'bad', 123, {}, '2026-02-30T00:00:00Z', '2026-10-08'])('rejects malformed copy timestamp %j', updated_at => {
  for (const kind of ['item', 'import']) expect(() => apply(kind, record(kind, { updated_at }))).toThrow()
})
it.each([{ total_rows: -1 }, { total_rows: 1.5 }, { total_rows: '3junk' }, { total_rows: null }, { total_rows: true },
  { total_rows: 2147483648 }, { total_rows: 2, processed_rows: 3 }, { processed_rows: {} }, { errors_log: {} },
  { errors_log: [null] }, { errors_log: [{ row: 1 }] }, { status: 'other' }])('rejects malformed history rather than inventing zero: %j', fields => {
  const before = snapshot()
  expect(() => catalog.upsertRemoteImport(header('history', fields), tenant, later)).toThrow()
  expect(snapshot()).toEqual(before)
})
it('retains omitted legacy history counters and errors instead of replacing them with zero', () => {
  catalog.upsertRemoteImport(header('history', { errors_log: [{ row: 2, error: 'Old warning' }] }), tenant, at)
  catalog.upsertRemoteImport({ id: 'history', updated_at: later }, tenant, later)
  expect(db.prepare('SELECT filename,total_rows,processed_rows,errors_json,mode,warehouse_name FROM supplier_price_imports').get())
    .toEqual({ filename: 'price.csv', total_rows: 3, processed_rows: 3, errors_json: '[{"row":2,"error":"Old warning"}]', mode: 'replace', warehouse_name: 'Main' })
})

it.each(['pull', 'bootstrap', 'sync'])('rolls back every row of a failed %s catalog batch', route => {
  db.exec("CREATE TRIGGER fault BEFORE INSERT ON supplier_price_imports BEGIN SELECT RAISE(IGNORE); END;")
  const before = snapshot()
  const input: any = { tenant_id: tenant, cursor: later, exported_at: later, supplier_price_items: [item()], supplier_price_imports: [header()] }
  expect(() => route === 'sync' ? new LocalSyncRepository(db).applyPullChanges(input)
    : route === 'pull' ? new LocalBootstrapRepository(db).applySyncChanges(tenant, input)
    : new LocalBootstrapRepository(db).importSnapshot(input)).toThrow()
  expect(snapshot()).toEqual(before)
})
it.each(['pull', 'bootstrap', 'sync', 'planner'])('rejects duplicate catalog IDs in %s instead of accepting the last one', route => {
  const input: any = { tenant_id: tenant, cursor: later, exported_at: later, supplier_price_items: [item(), item('item', { qty: 99 })] }
  const before = snapshot()
  expect(() => route === 'planner' ? createPullChangeChunks(input, 1) : route === 'sync' ? new LocalSyncRepository(db).applyPullChanges(input)
    : route === 'pull' ? new LocalBootstrapRepository(db).applySyncChanges(tenant, input) : new LocalBootstrapRepository(db).importSnapshot(input)).toThrow()
  expect(snapshot()).toEqual(before)
})
it.each(['supplier_price_items', 'supplier_price_imports'].flatMap(key => [null, {}, 'bad'].map(value => ({ key, value }))))
('rejects a malformed $key collection before splitting or importing', ({ key, value }) => {
  const input: any = { cursor: later, [key]: value }
  expect(() => createPullChangeChunks(input)).toThrow()
  expect(() => new LocalBootstrapRepository(db).applySyncChanges(tenant, input)).toThrow()
})
it.each(['bootstrap', 'sync'])('checks stored catalog data again after %s cursor writes', route => {
  db.exec("CREATE TRIGGER fault AFTER " + (route === 'sync' ? 'UPDATE OF pull_cursor' : 'INSERT') + " ON sync_state BEGIN UPDATE supplier_price_items SET qty=999 WHERE id='item'; END;")
  const before = snapshot()
  const input: any = { tenant_id: tenant, cursor: later, exported_at: later, supplier_price_items: [item()] }
  expect(() => route === 'sync' ? new LocalSyncRepository(db).applyPullChanges(input) : new LocalBootstrapRepository(db).importSnapshot(input)).toThrow()
  expect(snapshot()).toEqual(before)
})
it('keeps local unsent and unrelated catalog history intact in a valid complete batch and after restart', () => {
  const local = catalog.create({ name: 'Local', sku: 'LOCAL', price_kopecks: 99, qty: 4 })
  catalog.upsertRemoteImport(header('old'), tenant, at)
  const before = db.prepare('SELECT * FROM supplier_price_items WHERE id=?').get(local.id)
  const result = new LocalSyncRepository(db).applyPullChanges({ cursor: later, supplier_price_items: [item(), item(local.id)], supplier_price_imports: [header()] })
  expect(result.counts).toMatchObject({ supplier_price_items: 1, supplier_price_imports: 1 })
  expect(db.prepare('SELECT * FROM supplier_price_items WHERE id=?').get(local.id)).toEqual(before)
  expect(db.prepare('SELECT count(*) n FROM supplier_price_imports').get()).toEqual({ n: 2 })
  expect(db.prepare('SELECT qty_on_hand FROM products').get()).toEqual({ qty_on_hand: 7 })
  const saved = snapshot()
  db.close(); db = new LocalDatabase(root)
  expect(snapshot()).toEqual(saved)
})

it('keeps existing fields omitted by a partial legacy item copy', () => {
  db.prepare('INSERT INTO suppliers(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('supplier', tenant, 'Supplier', at, at)
  catalog.upsertRemoteItem(item('item', { supplier_id: 'supplier', barcode: '111', brand: 'Brand', warehouse_name: 'Main' }), tenant, at)
  catalog.upsertRemoteItem({ id: 'item', updated_at: later }, tenant, later)
  expect(db.prepare('SELECT supplier_id,sku,barcode,brand,name,qty,price_kopecks,warehouse_name FROM supplier_price_items').get())
    .toEqual({ supplier_id: 'supplier', sku: 'SKU', barcode: '111', brand: 'Brand', name: 'Fixture', qty: 0.125, price_kopecks: 1200, warehouse_name: 'Main' })
})
it('does not invent zero quantity for a new remote item that omitted it', () => {
  const before = snapshot()
  expect(() => catalog.upsertRemoteItem(item('item', { qty: undefined }), tenant, at)).toThrow()
  expect(snapshot()).toEqual(before)
})
it('accepts semantically identical error details in a different JSON key order', () => {
  catalog.upsertRemoteImport(header('history', { errors_log: [{ row: 1, error: 'Warning', raw: 'source' }] }), tenant, at)
  expect(() => catalog.upsertRemoteImport(header('history', { errors_log: [{ raw: 'source', error: 'Warning', row: 1 }] }), tenant, at)).not.toThrow()
  expect(JSON.parse((db.prepare('SELECT errors_json FROM supplier_price_imports').get() as any).errors_json))
    .toEqual([{ row: 1, error: 'Warning', raw: 'source' }])
})

it.each(['item', 'import'])('does not let an unversioned %s copy overwrite known data', kind => {
  apply(kind, record(kind))
  const before = snapshot()
  expect(() => apply(kind, record(kind, { updated_at: undefined, name: 'Changed', filename: 'changed.csv' }))).toThrow()
  expect(snapshot()).toEqual(before)
})
it.each(['item', 'import'])('preserves dirty %s even if another catalog write tries to change it', kind => {
  apply(kind, record(kind))
  db.prepare('UPDATE ' + table(kind) + ' SET dirty_at=?').run(at)
  db.exec('CREATE TRIGGER fault AFTER INSERT ON supplier_price_items BEGIN UPDATE ' + table(kind)
    + ' SET updated_at=' + "'2020-01-01T00:00:00Z'" + '; END;')
  const before = snapshot()
  expect(() => new LocalBootstrapRepository(db).applySyncChanges(tenant, {
    cursor: later, supplier_price_items: [item('another'), ...(kind === 'item' ? [item()] : [])],
    supplier_price_imports: kind === 'import' ? [header()] : [],
  })).toThrow()
  expect(snapshot()).toEqual(before)
})
it.each(['qty=0', 'price_kopecks=1', "name='Corrupted'", "tenant_id='another'", 'matched_product_id=NULL'])
('does not acknowledge a stored item altered by a database trigger: %s', assignment => {
  if (assignment === 'matched_product_id=NULL') {
    catalog.upsertRemoteItem(item(), tenant, at)
    db.prepare("UPDATE supplier_price_items SET matched_product_id='stock',match_kind='sku' WHERE id='item'").run()
  }
  const op = assignment === 'matched_product_id=NULL' ? 'UPDATE' : 'INSERT'
  db.exec('CREATE TRIGGER fault AFTER ' + op + ' ON supplier_price_items BEGIN UPDATE supplier_price_items SET ' + assignment + " WHERE id=NEW.id; END;")
  const before = snapshot()
  expect(() => catalog.upsertRemoteItem(item('item', { updated_at: later }), tenant, later)).toThrow()
  expect(snapshot()).toEqual(before)
})
it.each(['total_rows=999', 'processed_rows=0', "filename='Corrupted'", "errors_json='[]'", 'scope_known=0'])
('does not acknowledge corrupted stored history: %s', assignment => {
  db.exec('CREATE TRIGGER fault AFTER INSERT ON supplier_price_imports BEGIN UPDATE supplier_price_imports SET ' + assignment + ' WHERE id=NEW.id; END;')
  const before = snapshot()
  expect(() => catalog.upsertRemoteImport(header('history', { errors_log: [{ row: 2, error: 'Warning' }] }), tenant, at)).toThrow()
  expect(snapshot()).toEqual(before)
})
it('accepts identical versions in different time zones without false conflicts', () => {
  catalog.upsertRemoteItem(item(), tenant, at)
  expect(catalog.upsertRemoteItem(item('item', { updated_at: '2026-10-08T13:00:00.000+03:00' }), tenant, later)).toBe(true)
  expect(db.prepare('SELECT qty FROM supplier_price_items').get()).toEqual({ qty: 0.125 })
})
it('enriches missing history scope at the same explicit version without replacing other history fields', () => {
  catalog.upsertRemoteImport({ id: 'legacy', updated_at: at, filename: 'original.csv' }, tenant, at)
  catalog.upsertRemoteImport({ id: 'legacy', updated_at: at, mode: 'replace', warehouse_name: 'Main' }, tenant, at)
  expect(db.prepare('SELECT scope_known,mode,warehouse_name,filename FROM supplier_price_imports').get())
    .toEqual({ scope_known: 1, mode: 'replace', warehouse_name: 'Main', filename: 'original.csv' })
})
it('does not change the supplier of an existing import history record', () => {
  db.prepare('INSERT INTO suppliers(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('supplier', tenant, 'Supplier', at, at)
  catalog.upsertRemoteImport(header(), tenant, at)
  const before = snapshot()
  expect(() => catalog.upsertRemoteImport(header('history', { supplier_id: 'supplier', updated_at: later }), tenant, later)).toThrow()
  expect(snapshot()).toEqual(before)
})
it('rechecks applied items after importing the history header, without rescanning all products per row', () => {
  const input = { cursor: later, supplier_price_items: Array.from({ length: 251 }, (_, i) => item('item-' + i)), supplier_price_imports: [header()] }
  db.exec("CREATE TRIGGER fault AFTER INSERT ON supplier_price_imports BEGIN UPDATE supplier_price_items SET qty=777 WHERE id='item-0'; END;")
  const before = snapshot()
  expect(() => new LocalSyncRepository(db).applyPullChanges(input)).toThrow()
  expect(snapshot()).toEqual(before)
})
it('does not advance a chunked cursor or retain partial prices after failure and safely retries', async () => {
  const sync = new LocalSyncRepository(db)
  sync.applyPullChanges({ cursor: at })
  const input = { cursor: later, supplier_price_items: Array.from({ length: 26 }, (_, i) => item('item-' + i)), supplier_price_imports: [header()] }
  db.exec("CREATE TRIGGER fault BEFORE INSERT ON supplier_price_items WHEN NEW.id='item-25' BEGIN SELECT RAISE(IGNORE); END;")
  await expect(sync.applyPullChangesChunked(input)).rejects.toThrow()
  expect(db.prepare("SELECT pull_cursor FROM sync_state WHERE scope='desktop_server_pull'").get()).toEqual({ pull_cursor: at })
  expect(db.prepare('SELECT count(*) n FROM supplier_price_items').get()).toEqual({ n: 0 })
  expect(db.prepare('SELECT count(*) n FROM supplier_price_imports').get()).toEqual({ n: 0 })
  db.exec('DROP TRIGGER fault')
  await sync.applyPullChangesChunked(input)
  expect(db.prepare("SELECT pull_cursor FROM sync_state WHERE scope='desktop_server_pull'").get()).toEqual({ pull_cursor: later })
  expect(db.prepare('SELECT count(*) n FROM supplier_price_items').get()).toEqual({ n: 26 })
  expect(db.prepare('SELECT count(*) n FROM supplier_price_imports').get()).toEqual({ n: 1 })
  expect(db.prepare('SELECT qty_on_hand FROM products').get()).toEqual({ qty_on_hand: 7 })
})
