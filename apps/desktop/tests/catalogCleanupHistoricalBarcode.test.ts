import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { CatalogCleanupRepository } from '../src/repositories/catalogCleanupRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'

let directory: string, db: LocalDatabase, cleanup: CatalogCleanupRepository, pos: LocalPosRepository
const at = '2026-10-13T10:00:00.000Z', owner = '00000000-0000-4000-8000-000000000201', source = '00000000-0000-4000-8000-000000000202', target = '00000000-0000-4000-8000-000000000203'
const extraLabelId = '00000000-0000-4000-8000-000000000204'
const selection = { tenant_id: tenant, target_id: target, source_ids: [source], stock_review: 'pending' as const }
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'forsage-cleanup-label-history-')); db = new LocalDatabase(directory)
  db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,is_active,created_at,updated_at) VALUES(?,?,?,?,1,?,?)').run(owner, tenant, 'Owner', 'owner', at, at)
  const catalog = new LocalCatalogRepository(db)
  catalog.upsertProduct({ id: target, sku: 'M-100', name: 'Олива Test 1л', barcode: '4820000000001', qty_on_hand: 2, purchase_price: 10000, retail_price: 15000 })
  catalog.upsertProduct({ id: source, sku: '(12)', name: 'Олива Test 1 л', barcode: '2000000000002', qty_on_hand: 3, purchase_price: 10000, retail_price: 15000 })
  db.prepare('UPDATE products SET specs_json=? WHERE id=?').run(JSON.stringify({ note: 'Keep source metadata', cleanup_barcodes: ['PREVIOUS-LABEL', '2000000000002'] }), source)
  db.prepare('INSERT INTO product_barcodes(id,tenant_id,product_id,barcode,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(extraLabelId, tenant, source, 'SOURCE-EXTRA-03', at, at)
  pos = new LocalPosRepository(db)
  const shift = pos.openShift({ cashier_id: owner })
  db.prepare("INSERT INTO sales(id,tenant_id,sale_number,cashier_id,shift_id,status,total,payment_method,completed_at,created_at,updated_at) VALUES('old-receipt',?,'OLD-1',?,?,'completed',15000,'cash',?,?,?)").run(tenant, owner, shift, at, at, at)
  db.prepare("INSERT INTO sale_items(id,tenant_id,sale_id,product_id,description,sku,qty,unit_price,total,created_at,updated_at) VALUES('old-line',?,'old-receipt',?,'Олива Test 1 л','(12)',1,15000,15000,?,?)").run(tenant, source, at, at)
  cleanup = new CatalogCleanupRepository(db, { canMirrorMerge: () => true, externalBlockers: () => [] })
})
afterEach(() => {
  db.close()
  if (path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith('forsage-cleanup-label-history-')) rmSync(directory, { recursive: true, force: true })
})
function request() { return { ...selection, operation_id: randomUUID(), preview_fingerprint: cleanup.preview(selection).fingerprint, reason: 'Synthetic confirmed duplicate' } }

it('preserves source label provenance and its old receipt through an actual reviewed merge', () => {
  const beforeLine = db.prepare('SELECT * FROM sale_items').all()
  expect(pos.listSales({ product_barcode: 'SOURCE-EXTRA-03' }).data.map(row => row.id)).toEqual(['old-receipt'])
  const input = request(); cleanup.apply(input, owner)
  expect(db.prepare('SELECT product_id FROM product_barcodes WHERE id=?').get(extraLabelId)).toMatchObject({ product_id: target })
  const archived = db.prepare('SELECT specs_json FROM products WHERE id=?').get(source) as { specs_json: string }
  expect(JSON.parse(archived.specs_json)).toMatchObject({ note: 'Keep source metadata', merged_into_product_id: target,
    cleanup_barcodes: ['PREVIOUS-LABEL', '2000000000002', 'SOURCE-EXTRA-03'] })
  for (const code of ['SOURCE-EXTRA-03', 'PREVIOUS-LABEL', '2000000000002']) {
    for (const filter of [{ product_barcode: code }, { product_search: code }, { search: code }])
      expect(pos.listSales(filter).data.map(row => row.id)).toEqual(['old-receipt'])
  }
  expect(db.prepare('SELECT * FROM sale_items').all()).toEqual(beforeLine)
  const outbox = db.prepare("SELECT payload_json FROM sync_outbox WHERE operation_type='product.catalog_cleanup'").get() as { payload_json: string }
  expect(JSON.parse(outbox.payload_json).products.find((row: { id: string }) => row.id === source).specs.cleanup_barcodes).toEqual(['PREVIOUS-LABEL', '2000000000002', 'SOURCE-EXTRA-03'])
  expect(cleanup.apply(input, owner).operation_id).toBe(input.operation_id)
})

it('does not overwrite malformed pre-existing source barcode provenance', () => {
  db.prepare('UPDATE products SET specs_json=? WHERE id=?').run(JSON.stringify({ cleanup_barcodes: { old: 'DO-NOT-DISCARD' } }), source)
  const before = db.prepare('SELECT * FROM products ORDER BY id').all()
  expect(() => cleanup.apply(request(), owner)).toThrow(/штрихкод|істор|характерист/i)
  expect(db.prepare('SELECT * FROM products ORDER BY id').all()).toEqual(before)
  expect(db.prepare("SELECT count(*) n FROM sync_outbox WHERE operation_type='product.catalog_cleanup'").get()).toMatchObject({ n: 0 })
})
