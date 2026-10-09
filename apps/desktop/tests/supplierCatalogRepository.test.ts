import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { SUPPLIER_CATALOG_SCHEMA_SQL } from '../src/db/supplierCatalogSchema'
import { LocalSupplierCatalogRepository } from '../src/repositories/supplierCatalogRepository'

describe('LocalSupplierCatalogRepository', () => {
  let root = ''
  let db: LocalDatabase
  let repository: LocalSupplierCatalogRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-supplier-catalog-'))
    db = new LocalDatabase(root)
    db.exec(SUPPLIER_CATALOG_SCHEMA_SQL)
    repository = new LocalSupplierCatalogRepository(db)
    const now = new Date().toISOString()
    for (const [id, name] of [['supplier-a', 'Постачальник А'], ['supplier-b', 'Постачальник Б']]) {
      db.prepare(`
        INSERT INTO suppliers (id, tenant_id, name, is_active, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run(id, DEFAULT_TENANT_ID, name, now, now)
    }
    db.prepare(`
      INSERT INTO products (
        id, tenant_id, sku, name, barcode, unit, purchase_price, retail_price,
        qty_on_hand, reorder_point, is_active, is_service, specs_json,
        requires_core_return, core_deposit_amount, search_text, created_at, updated_at
      ) VALUES ('product-75', ?, 'AUTO-962876-42', 'Рулетка 7.5м Greener', '2000000000075',
        'шт', 10000, 15000, 1, 0, 1, 0, '{}', 0, 0, '', ?, ?)
    `).run(DEFAULT_TENANT_ID, now, now)
    db.prepare(`
      INSERT INTO product_barcodes (
        id, tenant_id, product_id, barcode, barcode_type, is_primary, created_at, updated_at
      ) VALUES ('barcode-extra', ?, 'product-75', '2000000000175', 'ean13', 0, ?, ?)
    `).run(DEFAULT_TENANT_ID, now, now)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-supplier-catalog-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('matches only exact barcode, SKU, or the full normalized name', () => {
    const byExtraBarcode = repository.create({
      supplier_id: 'supplier-a', sku: 'OTHER', barcode: '2000 0000-00175.0',
      name: 'Інша назва з прайсу', price_kopecks: 9000,
    })
    expect(byExtraBarcode.matched_product_id).toBe('product-75')
    expect(byExtraBarcode.match_kind).toBe('barcode')

    const fiveMeters = repository.create({
      supplier_id: 'supplier-a', sku: 'RUL-5M', barcode: '2000000000050',
      name: 'Рулетка 5м Greener', price_kopecks: 8000,
    })
    expect(fiveMeters.matched_product_id).toBeNull()

    const byFullName = repository.create({
      supplier_id: 'supplier-b', sku: 'DIFFERENT',
      name: '  РУЛЕТКА 7.5м — Greener ', price_kopecks: 8100,
    })
    expect(byFullName.matched_product_id).toBe('product-75')
    expect(byFullName.match_kind).toBe('name')
  })

  it('merges repeated add rows inside the same supplier scope and queues one atomic import', () => {
    repository.importRows('first.xlsx', [{
      source_row: 2, sku: 'BOLT-10', barcode: '2200000000010', name: 'Болт 10', qty: '1', price_kopecks: 100,
    }], { supplier_id: 'supplier-a', mode: 'add', warehouse_name: 'Основний' })
    repository.importRows('second.xlsx', [{
      source_row: 2, sku: 'BOLT-10', barcode: '2200000000010', name: 'Болт 10', qty: '2', price_kopecks: 110,
    }], { supplier_id: 'supplier-a', mode: 'add', warehouse_name: 'Основний' })

    const result = repository.list({ supplier_id: 'supplier-a', limit: 100 })
    expect(result.data).toHaveLength(1)
    expect(result.data[0].qty).toBe('3')
    expect(result.data[0].price_kopecks).toBe(110)
    const operations = db.prepare(`
      SELECT operation_type FROM sync_outbox
      WHERE operation_type = 'supplier_catalog.imported'
    `).all()
    expect(operations).toHaveLength(2)
  })

  it.each(['add','replace'] as const)('consolidates repeated input rows in %s into a unique final copy without losing quantity', mode => {
    const rows = [
      {source_row:1,sku:'BOLT',name:'Bolt',qty:'2',price_kopecks:100},
      {source_row:2,sku:'BOLT',name:'Bolt',qty:'3',price_kopecks:110},
      {source_row:3,sku:'BOLT',name:'Bolt',qty:'4',price_kopecks:120},
    ]
    const imported=repository.importRows('repeated.csv',rows,{supplier_id:'supplier-a',mode,warehouse_name:'Main'})
    const payload=JSON.parse((db.prepare('SELECT payload_json FROM sync_outbox WHERE aggregate_id=?').get(imported.importId) as any).payload_json)
    expect(repository.list({supplier_id:'supplier-a'}).data).toHaveLength(1)
    expect(repository.list({supplier_id:'supplier-a'}).data[0]).toMatchObject({qty:'9',price_kopecks:120})
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0]).toMatchObject({qty:'9',price_kopecks:120})
    expect(payload.import.processed_rows).toBe(3)
    expect(repository.getImport(imported.importId)?.processed_rows).toBe(3)
  })

  it('keeps import mode and warehouse when copying complete server history',()=>{
    repository.upsertRemoteImport({id:'remote-history',supplier_id:'supplier-a',filename:'price.csv',mode:'replace',warehouse_name:'Main'},DEFAULT_TENANT_ID,'2026-10-07T18:00:00Z')
    expect(db.prepare('SELECT mode,warehouse_name FROM supplier_price_imports WHERE id=?').get('remote-history')).toEqual({mode:'replace',warehouse_name:'Main'})
  })

  it('does not erase known import metadata with an older server response that lacks it',()=>{
    const imported=repository.importRows('local.csv',[{source_row:1,sku:'X',name:'X',qty:2,price_kopecks:100}],{supplier_id:'supplier-a',mode:'replace',warehouse_name:'Main'})
    db.exec('UPDATE supplier_price_imports SET dirty_at=NULL')
    repository.upsertRemoteImport({id:imported.importId,supplier_id:'supplier-a',filename:'local.csv'},DEFAULT_TENANT_ID,'2026-10-07T18:00:00Z')
    expect(db.prepare('SELECT mode,warehouse_name FROM supplier_price_imports WHERE id=?').get(imported.importId)).toEqual({mode:'replace',warehouse_name:'Main'})
  })


  it.each([{ mode: 'bad', warehouse_name: null }, { mode: 'add' }, { mode: 'replace', warehouse_name: {} }])('rejects malformed scope metadata without changing history: %j', fields => {
    expect(() => repository.upsertRemoteImport({ id: 'invalid', ...fields }, DEFAULT_TENANT_ID, '2026-10-07T18:00:00Z')).toThrow()
    expect(db.prepare('SELECT id FROM supplier_price_imports').all()).toHaveLength(0)
  })

  it('marks legacy scope unknown until a complete copy supplies evidence, then protects it', () => {
    const id = 'legacy-history', at = '2026-10-07T18:00:00Z'
    repository.upsertRemoteImport({ id }, DEFAULT_TENANT_ID, at)
    expect(db.prepare('SELECT scope_known FROM supplier_price_imports WHERE id=?').get(id)).toEqual({ scope_known: 0 })
    repository.upsertRemoteImport({ id, mode: 'replace', warehouse_name: 'Main' }, DEFAULT_TENANT_ID, at)
    expect(db.prepare('SELECT mode,warehouse_name,scope_known FROM supplier_price_imports WHERE id=?').get(id)).toEqual({ mode: 'replace', warehouse_name: 'Main', scope_known: 1 })
    const before = db.prepare('SELECT * FROM supplier_price_imports WHERE id=?').get(id)
    for (const fields of [{ mode: 'add', warehouse_name: 'Main' }, { mode: 'replace', warehouse_name: null }])
      expect(() => repository.upsertRemoteImport({ id, ...fields }, DEFAULT_TENANT_ID, at)).toThrow(/Конфлікт/)
    expect(db.prepare('SELECT * FROM supplier_price_imports WHERE id=?').get(id)).toEqual(before)
    repository.upsertRemoteImport({ id, mode: null, warehouse_name: null }, DEFAULT_TENANT_ID, at)
    expect(db.prepare('SELECT * FROM supplier_price_imports WHERE id=?').get(id)).toEqual(before)
    db.close()
    db = new LocalDatabase(root)
    expect(db.prepare('SELECT * FROM supplier_price_imports WHERE id=?').get(id)).toEqual(before)
  })

  it('records an explicitly unassigned warehouse as known for new imports and complete copies', () => {
    const imported = repository.importRows('local.csv', [{ source_row: 1, sku: 'X', name: 'X', qty: 1, price_kopecks: 100 }], { mode: 'add', supplier_id: null })
    repository.upsertRemoteImport({ id: 'remote-known', mode: 'replace', warehouse_name: null }, DEFAULT_TENANT_ID, '2026-10-07T18:00:00Z')
    for (const id of [imported.importId, 'remote-known'])
      expect(db.prepare('SELECT warehouse_name,scope_known FROM supplier_price_imports WHERE id=?').get(id)).toEqual({ warehouse_name: null, scope_known: 1 })
  })

  it.each(['add', 'replace'] as const)('copies final unique quantities across a 400-row boundary in %s without changing stock', mode => {
    repository.importRows('old.csv', [{ source_row: 1, sku: 'BOLT', name: 'Bolt', qty: 10, price_kopecks: 80 }], { mode: 'add', supplier_id: 'supplier-a' })
    const products = db.prepare('SELECT * FROM products').all()
    const rows = Array.from({ length: 401 }, (_, index) => ({ source_row: index + 1, sku: 'BOLT', name: 'Bolt', qty: 1, price_kopecks: 100 }))
    const imported = repository.importRows('large.csv', rows, { mode, supplier_id: 'supplier-a' })
    const payload = JSON.parse((db.prepare('SELECT payload_json FROM sync_outbox WHERE aggregate_id=?').get(imported.importId) as any).payload_json)
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0].qty).toBe(mode === 'add' ? '411' : '401')
    expect(payload.import.processed_rows).toBe(401)
    expect(db.prepare('SELECT * FROM products').all()).toEqual(products)
  })

  it('rolls back a replacement and consolidated quantities when recording the copy fails', () => {
    repository.importRows('old.csv', [{ source_row: 1, sku: 'OLD', name: 'Old', qty: 2, price_kopecks: 100 }], { mode: 'add', supplier_id: null })
    const snapshot = () => ['supplier_price_items', 'supplier_price_imports', 'sync_outbox', 'products'].map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all())
    const before = snapshot()
    db.exec("CREATE TRIGGER reject_catalog_queue BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT, 'fixture'); END;")
    expect(() => repository.importRows('new.csv', [1, 2].map(source_row => ({ source_row, sku: 'NEW', name: 'New', qty: 3, price_kopecks: 120 })), { mode: 'replace', supplier_id: null })).toThrow(/fixture/)
    expect(snapshot()).toEqual(before)
  })

  it('replace affects only the selected supplier and warehouse scope', () => {
    repository.importRows('old-a.xlsx', [{
      source_row: 2, sku: 'OLD-A', name: 'Старий А', qty: 1, price_kopecks: 100,
    }], { supplier_id: 'supplier-a', mode: 'add', warehouse_name: 'Основний' })
    repository.importRows('old-b.xlsx', [{
      source_row: 2, sku: 'OLD-B', name: 'Старий Б', qty: 1, price_kopecks: 200,
    }], { supplier_id: 'supplier-b', mode: 'add', warehouse_name: 'Основний' })

    const result = repository.importRows('new-a.xlsx', [{
      source_row: 2, sku: 'NEW-A', name: 'Новий А', qty: 4, price_kopecks: 300,
    }], { supplier_id: 'supplier-a', mode: 'replace', warehouse_name: 'Основний' })

    expect(repository.getImport(result.importId)?.processed_rows).toBe(1)
    expect(repository.list({ supplier_id: 'supplier-a', limit: 100 }).data.map((item) => item.sku)).toEqual(['NEW-A'])
    expect(repository.list({ supplier_id: 'supplier-b', limit: 100 }).data.map((item) => item.sku)).toEqual(['OLD-B'])
    const removed = db.prepare(`
      SELECT deleted_at FROM supplier_price_items WHERE sku = 'OLD-A'
    `).get() as { deleted_at: string | null }
    expect(removed.deleted_at).toBeTruthy()
  })

  it('shows a duplicate conflict instead of silently creating another draft row', () => {
    repository.create({ supplier_id: 'supplier-a', sku: 'ONE', name: 'Одна позиція', price_kopecks: 100 })
    expect(() => repository.create({
      supplier_id: 'supplier-a', sku: 'ONE', name: 'Інша назва', price_kopecks: 200,
    })).toThrow('вже існує')
    expect(repository.list({ supplier_id: 'supplier-a' }).data).toHaveLength(1)
  })

  it('does not overwrite a dirty local item with an older remote pull', () => {
    const local = repository.create({
      supplier_id: 'supplier-a', sku: 'LOCAL', name: 'Локальна назва', price_kopecks: 100,
    })
    const applied = repository.upsertRemoteItem({
      id: local.id, supplier_id: 'supplier-a', sku: 'LOCAL', name: 'Серверна назва', price_kopecks: 999,
    }, DEFAULT_TENANT_ID, new Date().toISOString())
    expect(applied).toBe(false)
    expect(repository.list({ query: 'Локальна назва' }).data[0]?.name).toBe('Локальна назва')
  })
})
