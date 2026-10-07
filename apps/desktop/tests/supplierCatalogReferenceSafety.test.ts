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
    if (action === 'remote item') catalog.upsertRemoteItem({ ...item, id: 'remote-item', supplier_id: source }, tenant, '2026-10-07T06:00:00Z')
    if (action === 'remote import') catalog.upsertRemoteImport({ id: 'remote-import', supplier_id: source, filename: 'test.csv' }, tenant, '2026-10-07T06:00:00Z')
  }).toThrow(/Постачальник/)
  expect(snapshot()).toEqual(before)
})
it('preserves explicitly unassigned scope and valid suppliers', () => {
  catalog.importRows('test.csv', [{ ...item, source_row: 1 }], { supplier_id: source, mode: 'replace' })
  expect(db.prepare('SELECT count(*) n FROM supplier_price_items WHERE supplier_id IS NULL AND deleted_at IS NULL').get()).toEqual({n:1})
  catalog.importRows('no-supplier.csv', [{ ...item, sku: 'OTHER', source_row: 1 }], { supplier_id: null, mode: 'replace' })
  expect(db.prepare('SELECT count(*) n FROM supplier_price_items WHERE supplier_id=? AND deleted_at IS NULL').get(source)).toEqual({n:1})
})
