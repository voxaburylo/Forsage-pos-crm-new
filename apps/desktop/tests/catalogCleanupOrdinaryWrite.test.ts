import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'

let directory: string, db: LocalDatabase, catalog: LocalCatalogRepository
const card = { id: 'reviewed-card', sku: 'REVIEWED-1', name: 'Reviewed product', qty_on_hand: 7, retail_price: 15000, purchase_price: 10000 }
const provenance = {
  cleanup_sources: [{ id: 'old-source', name: 'Original name', specs: { size: '10' }, merge_operation_id: 'operation-1' }],
  cleanup_stock_review: { status: 'pending', user_id: 'owner', at: '2026-10-13', operation_id: 'operation-1' },
  cleanup_mirror_receipts: [{ operation_id: 'operation-1', hash: 'original-hash' }],
  cleanup_mirrored_at: '2026-10-13', cleanup_barcodes: ['HISTORICAL-LABEL'], merge_operation_id: 'operation-1',
}
const forged = { cleanup_sources: [], cleanup_stock_review: { status: 'checked' }, cleanup_mirror_receipts: [],
  cleanup_mirrored_at: '2099-01-01', cleanup_barcodes: ['WRONG-LABEL'], merged_into_product_id: 'wrong-target', merge_operation_id: 'forged-operation' }
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'forsage-cleanup-write-guard-')); db = new LocalDatabase(directory)
  catalog = new LocalCatalogRepository(db); catalog.upsertProduct(card)
})
afterEach(() => {
  db.close()
  if (path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith('forsage-cleanup-write-guard-')) rmSync(directory, { recursive: true, force: true })
})
const specs = () => JSON.parse((db.prepare('SELECT specs_json FROM products WHERE id=?').get(card.id) as { specs_json: string }).specs_json)
function seedProvenance() { db.prepare('UPDATE products SET specs_json=? WHERE id=?').run(JSON.stringify({ size: '10', ...provenance }), card.id) }
const methods = ['upsertProduct', 'saveProduct'] as const

for (const method of methods) {
  it.each([{}, null, forged])(`${method} preserves stored cleanup provenance when the ordinary editor clears or replaces specs: %j`, inputSpecs => {
    seedProvenance()
    catalog[method]({ ...card, name: 'Edited name', specs: inputSpecs as never })
    expect(specs()).toEqual(provenance)
    expect(catalog.findById(card.id)).toMatchObject({ name: 'Edited name', qty_on_hand: 7, retail_price: 15000, purchase_price: 10000 })
    if (method === 'saveProduct') {
      const queued = db.prepare("SELECT payload_json FROM sync_outbox WHERE operation_type='product.upsert' ORDER BY sequence DESC LIMIT 1").get() as { payload_json: string }
      expect(JSON.parse(queued.payload_json).specs).toEqual(provenance)
    }
  })
  it(`${method} preserves cleanup provenance when specs are omitted`, () => {
    seedProvenance(); catalog[method]({ ...card, name: 'Partial edit' })
    expect(specs()).toMatchObject(provenance)
  })
  it.each(['existing', 'new'])(`${method} strips injected cleanup identity and audit fields from a %s ordinary card`, kind => {
    const input = kind === 'new' ? { ...card, id: 'new-card', sku: 'NEW-1' } : card
    catalog[method]({ ...input, specs: { size: '20', ...forged } as never })
    const row = db.prepare('SELECT specs_json FROM products WHERE id=?').get(input.id) as { specs_json: string }
    expect(JSON.parse(row.specs_json)).toEqual({ size: '20' })
  })
  it.each(['not-json', 'null', '[]'])(`${method} fails without writes for unreadable stored specs: %s`, value => {
    db.prepare('UPDATE products SET specs_json=? WHERE id=?').run(value, card.id)
    const before = db.prepare('SELECT * FROM products').all(), outbox = db.prepare('SELECT * FROM sync_outbox').all()
    expect(() => catalog[method]({ ...card, name: 'Must not apply', specs: {} })).toThrow()
    expect(db.prepare('SELECT * FROM products').all()).toEqual(before)
    expect(db.prepare('SELECT * FROM sync_outbox').all()).toEqual(outbox)
  })
  it.each([[], 'invalid'])(`${method} rejects a non-object incoming specs value: %j`, value => {
    seedProvenance()
    const before = db.prepare('SELECT * FROM products').all(), outbox = db.prepare('SELECT * FROM sync_outbox').all()
    expect(() => catalog[method]({ ...card, specs: value as never })).toThrow(/формат/)
    expect(db.prepare('SELECT * FROM products').all()).toEqual(before)
    expect(db.prepare('SELECT * FROM sync_outbox').all()).toEqual(outbox)
  })
  it(`${method} still refuses to resurrect a merged source even with cleared specs`, () => {
    db.prepare('UPDATE products SET specs_json=?,deleted_at=?,is_active=0 WHERE id=?').run(JSON.stringify({ merged_into_product_id: 'canonical', cleanup_barcodes: ['OLD'] }), '2026-10-13', card.id)
    const before = db.prepare('SELECT * FROM products').all()
    expect(() => catalog[method]({ ...card, specs: {} })).toThrow(/об’єднано/)
    expect(db.prepare('SELECT * FROM products').all()).toEqual(before)
  })
}
