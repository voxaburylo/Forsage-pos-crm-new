import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import { LocalSupplierCatalogRepository } from '../src/repositories/supplierCatalogRepository'

let root: string, db: LocalDatabase, catalog: LocalSupplierCatalogRepository, source: string
const item = { name: 'Тестова позиція', sku: 'TEST', price_kopecks: 12000, qty: '2' }

it.each(['item','import'])('rejects a foreign clean %s ID instead of overwriting its data', kind => {
  const at = '2026-10-07T06:00:00Z'
  const record = { ...item, id: 'existing-record', supplier_id: null, filename: 'original.csv' }
  if (kind === 'item') catalog.upsertRemoteItem(record, tenant, at)
  else catalog.upsertRemoteImport(record, tenant, at)
  const table = kind === 'item' ? 'supplier_price_items' : 'supplier_price_imports'
  db.prepare('UPDATE ' + table + ' SET tenant_id=? WHERE id=?').run('another-tenant', record.id)
  const before = snapshot()
  const changed = { ...record, name: 'Unexpected replacement', filename: 'changed.csv' }
  expect(() => kind === 'item'
    ? catalog.upsertRemoteItem(changed, tenant, at)
    : catalog.upsertRemoteImport(changed, tenant, at)).toThrow(/належ|організаці/i)
  expect(snapshot()).toEqual(before)
})
it.each(['item','import'])('rejects a %s copy explicitly addressed to another tenant', kind => {
  const record = { ...item, id: 'new-record', tenant_id: 'another-tenant', supplier_id: null, filename: 'wrong.csv' }
  const before = snapshot()
  expect(() => kind === 'item'
    ? catalog.upsertRemoteItem(record, tenant, '2026-10-07T06:00:00Z')
    : catalog.upsertRemoteImport(record, tenant, '2026-10-07T06:00:00Z')).toThrow(/належ|організаці/i)
  expect(snapshot()).toEqual(before)
})
it.each(['item','import'])('keeps a local unsent %s unchanged and reports that it was skipped', kind => {
  const at = '2026-10-07T06:00:00Z'
  const record = { ...item, id: 'dirty-record', supplier_id: null, filename: 'local.csv' }
  if (kind === 'item') catalog.upsertRemoteItem(record, tenant, at)
  else catalog.upsertRemoteImport(record, tenant, at)
  const table = kind === 'item' ? 'supplier_price_items' : 'supplier_price_imports'
  db.prepare('UPDATE ' + table + ' SET dirty_at=? WHERE id=?').run(at, record.id)
  const before = snapshot()
  expect(kind === 'item' ? catalog.upsertRemoteItem(record, tenant, at) : catalog.upsertRemoteImport(record, tenant, at)).toBe(false)
  expect(snapshot()).toEqual(before)
})
it.each(['item','import'])('still updates a clean %s owned by the selected tenant', kind => {
  const at = '2026-10-07T06:00:00Z'
  const record = { ...item, id: 'owned-record', tenant_id: tenant, supplier_id: null, filename: 'original.csv', updated_at: at }
  const apply = (value: any) => kind === 'item' ? catalog.upsertRemoteItem(value, tenant, at) : catalog.upsertRemoteImport(value, tenant, at)
  expect(apply(record)).toBe(true)
  expect(apply({ ...record, name: 'Оновлена назва', filename: 'new.csv', updated_at: '2026-10-07T07:00:00Z' })).toBe(true)
  if (kind === 'item') expect(db.prepare('SELECT name FROM supplier_price_items WHERE id=?').get(record.id)).toEqual({ name: 'Оновлена назва' })
  else expect(db.prepare('SELECT filename FROM supplier_price_imports WHERE id=?').get(record.id)).toEqual({ filename: 'new.csv' })
})

it.each(['item','import'])('rejects if the database declines a clean %s update', kind => {
  const at = '2026-10-07T06:00:00Z'
  const record = { ...item, id: 'skipped-record', supplier_id: null, filename: 'original.csv' }
  const apply = (value: any) => kind === 'item' ? catalog.upsertRemoteItem(value, tenant, at) : catalog.upsertRemoteImport(value, tenant, at)
  expect(apply(record)).toBe(true)
  const table = kind === 'item' ? 'supplier_price_items' : 'supplier_price_imports'
  db.exec('CREATE TRIGGER suppress_price_update BEFORE UPDATE ON ' + table + ' BEGIN SELECT RAISE(IGNORE); END;')
  const before = snapshot()
  expect(() => apply({ ...record, name: 'Do not save', filename: 'changed.csv', updated_at: '2026-10-07T07:00:00Z' })).toThrow(/Прайс/)
  expect(snapshot()).toEqual(before)
})

const snapshot = () => Object.fromEntries(['suppliers','supplier_price_items','supplier_price_imports','sync_outbox','products']
  .map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]))
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-price-supplier-'))
  db = new LocalDatabase(root)
  catalog = new LocalSupplierCatalogRepository(db)
  source = new LocalSupplyRepository(db).saveSupplier({ name: 'Постачальник' }).id
  catalog.create({ ...item, sku: 'UNASSIGNED', name: 'Незалежний прайс', supplier_id: null })
})
afterEach(() => {
  db.close()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-price-supplier-')) rmSync(root, { recursive: true, force: true })
})
it.each(['missing','deleted','inactive','foreign','merged'])('rejects %s supplier instead of replacing the unassigned price list', kind => {
  if (kind === 'missing') source = 'missing'
  if (kind === 'deleted') new LocalSupplyRepository(db).deleteSupplier(source)
  if (kind === 'inactive') db.prepare('UPDATE suppliers SET is_active=0 WHERE id=?').run(source)
  if (kind === 'foreign') db.prepare('UPDATE suppliers SET tenant_id=? WHERE id=?').run('other', source)
  if (kind === 'merged') {
    const supply = new LocalSupplyRepository(db)
    supply.mergeSuppliers(supply.saveSupplier({ name: 'Основний' }).id, source)
  }
  const before = snapshot()
  expect(() => catalog.importRows('test.csv', [{ ...item, source_row: 1 }], { supplier_id: source, mode: 'replace' })).toThrow(/Постачальник/)
  expect(snapshot()).toEqual(before)
})
it.each(['create','update','remote item','remote import'])('rejects stale supplier on %s without silently losing the reference', action => {
  const original = catalog.create({ ...item, supplier_id: source })
  new LocalSupplyRepository(db).deleteSupplier(source)
  const before = snapshot()
  expect(() => {
    if (action === 'create') catalog.create({ ...item, supplier_id: source })
    if (action === 'update') catalog.update(original.id, { name: 'Змінена назва' })
    if (action === 'remote item') catalog.upsertRemoteItem({ ...item, id: 'remote-item', supplier_id: 'missing' }, tenant, '2026-10-07T06:00:00Z')
    if (action === 'remote import') catalog.upsertRemoteImport({ id: 'remote-import', supplier_id: 'missing', filename: 'test.csv' }, tenant, '2026-10-07T06:00:00Z')
  }).toThrow(/Постачальник/)
  expect(snapshot()).toEqual(before)
})
it.each(['deleted','inactive'])('preserves the supplier ID in historical copies with an existing %s parent', kind => {
  if (kind === 'deleted') new LocalSupplyRepository(db).deleteSupplier(source)
  else db.prepare('UPDATE suppliers SET is_active=0 WHERE id=?').run(source)
  catalog.upsertRemoteItem({ ...item, id: 'old-item', supplier_id: source }, tenant, '2026-10-07T06:00:00Z')
  catalog.upsertRemoteImport({ id: 'old-import', supplier_id: source, filename: 'old.csv' }, tenant, '2026-10-07T06:00:00Z')
  expect(db.prepare('SELECT supplier_id FROM supplier_price_items WHERE id=?').get('old-item')).toEqual({supplier_id:source})
  expect(db.prepare('SELECT supplier_id FROM supplier_price_imports WHERE id=?').get('old-import')).toEqual({supplier_id:source})
  expect(() => catalog.create({ ...item, supplier_id: source })).toThrow(/Постачальник/)
})
it.each(['remote item','remote import'])('rejects a late %s for a merged supplier without restoring it', action => {
  const supply = new LocalSupplyRepository(db)
  supply.mergeSuppliers(supply.saveSupplier({name:'Основний'}).id,source)
  const before=snapshot()
  expect(() => {
    if(action==='remote item')catalog.upsertRemoteItem({...item,id:'late-item',supplier_id:source},tenant,'2026-10-07T06:00:00Z')
    else catalog.upsertRemoteImport({id:'late-import',supplier_id:source,filename:'late.csv'},tenant,'2026-10-07T06:00:00Z')
  }).toThrow(/Постачальник/)
  expect(snapshot()).toEqual(before)
})
it('preserves explicitly unassigned scope and valid suppliers', () => {
  catalog.importRows('test.csv', [{ ...item, source_row: 1 }], { supplier_id: source, mode: 'replace' })
  expect(db.prepare('SELECT count(*) n FROM supplier_price_items WHERE supplier_id IS NULL AND deleted_at IS NULL').get()).toEqual({n:1})
  catalog.importRows('no-supplier.csv', [{ ...item, sku: 'OTHER', source_row: 1 }], { supplier_id: null, mode: 'replace' })
  expect(db.prepare('SELECT count(*) n FROM supplier_price_items WHERE supplier_id=? AND deleted_at IS NULL').get(source)).toEqual({n:1})
})
