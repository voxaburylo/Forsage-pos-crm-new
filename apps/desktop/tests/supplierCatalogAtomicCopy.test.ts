import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalSyncRepository } from '../src/repositories/syncRepository'
import { LocalBootstrapRepository } from '../src/repositories/bootstrapRepository'
import { LocalSupplierCatalogRepository } from '../src/repositories/supplierCatalogRepository'
import { createPullChangeChunks } from '../src/repositories/syncPullPlanner'

const at = '2026-10-08T10:00:00.000Z', later = '2026-10-08T11:00:00.000Z'
let db: LocalDatabase, root: string, sync: LocalSyncRepository
const item = (id: string, fields = {}) => ({ id, sku: id, name: 'Price ' + id, qty: '0.125', price_kopecks: 100, updated_at: at, ...fields })
const copy = (n = 26): any => ({
  tenant_id: tenant, cursor: later, exported_at: later,
  supplier_price_items: Array.from({ length: n }, (_, i) => item('item-' + i)),
  supplier_price_imports: [{ id: 'history', filename: 'price.csv', total_rows: n, processed_rows: n, updated_at: at, mode: 'replace', warehouse_name: null }],
})
const tables = () => ['supplier_price_items','supplier_price_imports','products','sync_outbox','app_meta']
  .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all())
const cursor = () => (db.prepare("SELECT pull_cursor FROM sync_state WHERE scope='desktop_server_pull'").get() as any)?.pull_cursor
const apply = (route: string, input: any) => route === 'chunked' ? sync.applyPullChangesChunked(input)
  : route === 'bootstrap-chunked' ? sync.importSnapshotChunked(input)
  : route === 'sync' ? Promise.resolve().then(() => sync.applyPullChanges(input))
  : Promise.resolve().then(() => new LocalBootstrapRepository(db).importSnapshot(input))
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-catalog-atomic-'))
  db = new LocalDatabase(root); sync = new LocalSyncRepository(db)
  db.prepare('INSERT INTO products(id,tenant_id,sku,name,qty_on_hand,created_at,updated_at) VALUES(?,?,?,?,7,?,?)')
    .run('stock', tenant, 'STOCK', 'Stock fixture', at, at)
  sync.applyPullChanges({ cursor: at })
})
afterEach(() => {
  db.close()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-catalog-atomic-')) rmSync(root, { recursive: true, force: true })
})
it('plans price rows and import history as one final unit after other dependencies', () => {
  const input = { ...copy(100), products: [{ id: 'product' }], deleted_supplier_ids: ['deleted'] }
  const chunks = createPullChangeChunks(input, 1)
  const prices = chunks.filter(part => part.supplier_price_items || part.supplier_price_imports)
  expect(prices).toHaveLength(1)
  expect(prices[0]).toBe(chunks.at(-1))
  expect(prices[0].supplier_price_items).toHaveLength(100)
  expect(prices[0].supplier_price_imports).toHaveLength(1)
})
it.each(['chunked','bootstrap-chunked'])('does not expose a half-applied %s price list', async route => {
  const input = copy(76)
  db.exec("CREATE TRIGGER fault BEFORE INSERT ON supplier_price_items WHEN NEW.id='item-75' BEGIN SELECT RAISE(IGNORE); END;")
  const before = tables()
  await expect(apply(route, input)).rejects.toThrow()
  expect(tables()).toEqual(before)
  expect(cursor()).toBe(at)
})
it.each(['chunked','bootstrap-chunked'])('rolls back %s price rows when saving history fails', async route => {
  db.exec('CREATE TRIGGER fault BEFORE INSERT ON supplier_price_imports BEGIN SELECT RAISE(IGNORE); END;')
  const before = tables()
  await expect(apply(route, copy())).rejects.toThrow()
  expect(tables()).toEqual(before)
  expect(cursor()).toBe(at)
})
const routes = ['chunked','bootstrap-chunked','sync','bootstrap']
it.each(routes.flatMap(route => ['skip', 'rewrite', 'stock'].map(fault => ({ route, fault }))))
('does not accept $route completion with $fault cursor write', async ({ route, fault }) => {
  db.exec('CREATE TRIGGER fault ' + (fault === 'skip' ? 'BEFORE' : 'AFTER') + ' UPDATE OF pull_cursor ON sync_state BEGIN '
    + (fault === 'skip' ? 'SELECT RAISE(IGNORE);' : fault === 'rewrite' ? "UPDATE sync_state SET pull_cursor='wrong' WHERE scope=NEW.scope;"
      : "UPDATE products SET qty_on_hand=0 WHERE id='stock';") + ' END;')
  const before = tables()
  await expect(apply(route, copy())).rejects.toThrow()
  expect(tables()).toEqual(before)
  expect(cursor()).toBe(at)
})
it.each(routes.flatMap(route => ['item', 'history'].map(kind => ({ route, kind }))))
('rolls back $route on a late $kind alteration from completion metadata', async ({ route, kind }) => {
  db.exec('CREATE TRIGGER fault AFTER UPDATE OF pull_cursor ON sync_state BEGIN '
    + (kind === 'item' ? "UPDATE supplier_price_items SET qty=99 WHERE id='item-0';" : "UPDATE supplier_price_imports SET processed_rows=0 WHERE id='history';") + ' END;')
  const before = tables()
  await expect(apply(route, copy())).rejects.toThrow()
  expect(tables()).toEqual(before)
  expect(cursor()).toBe(at)
})
it.each(routes.flatMap(route => ['skip', 'rewrite'].map(fault => ({ route, fault }))))
('rejects $route completion with $fault reference timestamp', async ({ route, fault }) => {
  db.exec('CREATE TRIGGER fault ' + (fault === 'skip' ? 'BEFORE' : 'AFTER') + " INSERT ON app_meta WHEN NEW.key='desktop_last_reference_sync_at' BEGIN "
    + (fault === 'skip' ? 'SELECT RAISE(IGNORE);' : "UPDATE app_meta SET value_json='null' WHERE key=NEW.key;") + ' END;')
  const before = tables()
  await expect(apply(route, { ...copy(), references_included: true })).rejects.toThrow()
  expect(tables()).toEqual(before)
  expect(cursor()).toBe(at)
})
it.each(['bootstrap','bootstrap-chunked'].flatMap(route => ['skip','rewrite'].map(fault => ({ route, fault }))))
('rejects $route when bootstrap receipt is $fault', async ({ route, fault }) => {
  db.exec('CREATE TRIGGER fault ' + (fault === 'skip' ? 'BEFORE' : 'AFTER') + " INSERT ON app_meta WHEN NEW.key='last_bootstrap_snapshot' BEGIN "
    + (fault === 'skip' ? 'SELECT RAISE(IGNORE);' : "UPDATE app_meta SET value_json='{}' WHERE key=NEW.key;") + ' END;')
  const before = tables()
  await expect(apply(route, copy())).rejects.toThrow()
  expect(tables()).toEqual(before)
  expect(cursor()).toBe(at)
})
it('does not commit prices before later dependency cleanup succeeds', async () => {
  db.prepare('INSERT INTO product_aliases(id,tenant_id,product_id,alias,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('alias', tenant, 'stock', 'Old alias', at, at)
  db.exec("CREATE TRIGGER fault BEFORE DELETE ON product_aliases BEGIN SELECT RAISE(ABORT, 'cleanup fixture'); END;")
  const before = tables()
  await expect(sync.applyPullChangesChunked({ ...copy(), references_included: true })).rejects.toThrow()
  expect(tables()).toEqual(before)
  expect(cursor()).toBe(at)
})
it('does not expose intermediate price rows between asynchronous chunks', async () => {
  const observed: number[] = []
  let stopped = false
  const observe = () => {
    if (stopped) return
    observed.push(Number((db.prepare('SELECT count(*) n FROM supplier_price_items').get() as any).n))
    setImmediate(observe)
  }
  observe()
  try { await sync.applyPullChangesChunked(copy(76)) } finally { stopped = true }
  expect(observed.every(n => n === 0 || n === 76)).toBe(true)
  expect(db.prepare('SELECT count(*) n FROM supplier_price_items').get()).toEqual({ n: 76 })
})
it('freezes the downloaded catalog while other chunks yield to user work', async () => {
  const input = { ...copy(), products: [{ id: 'another', sku: 'ANOTHER', name: 'Other', qty_on_hand: 0 }] }
  const promise = sync.applyPullChangesChunked(input)
  input.supplier_price_items[0].qty = 999
  input.supplier_price_imports[0].filename = 'changed'
  await promise
  expect(db.prepare("SELECT qty FROM supplier_price_items WHERE id='item-0'").get()).toEqual({ qty: 0.125 })
  expect(db.prepare('SELECT filename FROM supplier_price_imports').get()).toEqual({ filename: 'price.csv' })
})
it('preserves a local catalog edit made before the deferred final transaction', async () => {
  const catalog = new LocalSupplierCatalogRepository(db)
  catalog.upsertRemoteItem(item('item-0'), tenant, at)
  const promise = sync.applyPullChangesChunked({ ...copy(), products: [{ id: 'another', sku: 'ANOTHER', name: 'Other', qty_on_hand: 0 }] })
  catalog.update('item-0', { qty: 9 })
  await promise
  expect(db.prepare("SELECT qty FROM supplier_price_items WHERE id='item-0'").get()).toEqual({ qty: 9 })
})
it('retries an atomic failure once, keeps older history, and persists exact completion counts after restart', async () => {
  new LocalSupplierCatalogRepository(db).upsertRemoteImport({ id: 'old', filename: 'old.csv' }, tenant, at)
  const input = copy()
  db.exec("CREATE TRIGGER fault BEFORE INSERT ON supplier_price_imports WHEN NEW.id='history' BEGIN SELECT RAISE(IGNORE); END;")
  await expect(sync.importSnapshotChunked(input)).rejects.toThrow()
  db.exec('DROP TRIGGER fault')
  await sync.importSnapshotChunked(input)
  await sync.importSnapshotChunked(input)
  expect(db.prepare('SELECT count(*) n FROM supplier_price_items').get()).toEqual({ n: 26 })
  expect(db.prepare('SELECT count(*) n FROM supplier_price_imports').get()).toEqual({ n: 2 })
  const receipt = JSON.parse((db.prepare("SELECT value_json FROM app_meta WHERE key='last_bootstrap_snapshot'").get() as any).value_json)
  expect(receipt.counts).toMatchObject({ supplier_price_items: 26, supplier_price_imports: 1 })
  const saved = tables()
  db.close(); db = new LocalDatabase(root)
  expect(tables()).toEqual(saved)
  expect(cursor()).toBe(later)
})

it('keeps the original cursor and completion flags when the caller changes its object during a yield', async () => {
  const input = { ...copy(), references_included: false, reset_generation: 4,
    products: [{ id: 'another', sku: 'ANOTHER', name: 'Other', qty_on_hand: 0 }] }
  const pending = sync.applyPullChangesChunked(input)
  input.cursor = '2099-01-01T00:00:00Z'
  input.reset_generation = 99
  input.references_included = true
  await pending
  expect(cursor()).toBe(later)
  expect(db.prepare("SELECT value_json FROM app_meta WHERE key='desktop_server_reset_generation'").get()).toEqual({ value_json: '4' })
  expect(db.prepare("SELECT value_json FROM app_meta WHERE key='desktop_last_reference_sync_at'").get()).toBeUndefined()
})
it.each(['skip','rewrite'])('does not finalize prices with a %s reset generation acknowledgement', async fault => {
  db.exec('CREATE TRIGGER fault ' + (fault === 'skip' ? 'BEFORE' : 'AFTER') + " INSERT ON app_meta WHEN NEW.key='desktop_server_reset_generation' BEGIN "
    + (fault === 'skip' ? 'SELECT RAISE(IGNORE);' : "UPDATE app_meta SET value_json='99' WHERE key=NEW.key;") + ' END;')
  const before = tables()
  await expect(sync.applyPullChangesChunked({ ...copy(), reset_generation: 4 })).rejects.toThrow()
  expect(tables()).toEqual(before)
  expect(cursor()).toBe(at)
})
it('accepts an empty price response without erasing existing supplier rows or history', async () => {
  await sync.applyPullChangesChunked(copy())
  const before = tables()
  await sync.applyPullChangesChunked({ cursor: later, supplier_price_items: [], supplier_price_imports: [] })
  expect(tables()).toEqual(before)
})
