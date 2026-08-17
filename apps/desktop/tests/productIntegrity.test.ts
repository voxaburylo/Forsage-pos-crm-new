import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { catalogCodesFromName, LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSyncRepository } from '../src/repositories/syncRepository'

describe('local product integrity', () => {
  let root = ''
  let db: LocalDatabase
  let catalog: LocalCatalogRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-product-integrity-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-product-integrity-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores a deleted SKU with the new card data and zero old stock', () => {
    const id = randomUUID()
    catalog.upsertProduct({ id, sku: 'RESTORE-1', name: 'Стара назва', barcode: '111', qty_on_hand: 7, retail_price: 100 })
    catalog.deleteProduct(id)

    const restored = catalog.saveProduct({
      id: randomUUID(), sku: 'RESTORE-1', name: 'Нова назва', barcode: '222',
      qty_on_hand: 0, retail_price: 250,
    }, { reuseExistingSku: true })

    expect(restored).toMatchObject({ id, name: 'Нова назва', barcode: '222', qty_on_hand: 0, retail_price: 250 })
  })

  it('rejects a barcode accidentally entered as a price', () => {
    expect(() => catalog.upsertProduct({
      id: randomUUID(), sku: 'BAD-PRICE', name: 'Помилкова ціна', retail_price: 200099879292300,
    })).toThrow(/Ціна продажу/)
  })

  it('finds local analogs by exact catalog codes from crosses and names', () => {
    expect(catalogCodesFromName('Фільтр MAN W811/80')).toContain('W81180')
    expect(catalogCodesFromName('Фільтр MAN W811/80')).not.toContain('MANW81180')
    expect(catalogCodesFromName('Фільтр MAHLE OC 196')).toContain('OC196')

    const sourceId = randomUUID()
    catalog.upsertProduct({
      id: sourceId,
      sku: '77267',
      name: 'Фільтр масляний MAN W811/80',
      cross_numbers: ['WIX: WL7131', 'MAHLE OC 196'],
      qty_on_hand: 5,
      retail_price: 34000,
    })
    catalog.upsertProduct({
      id: randomUUID(),
      sku: '77829',
      name: 'Фільтр масляний WIX WL7131',
      qty_on_hand: 2,
      retail_price: 22500,
    })
    catalog.upsertProduct({
      id: randomUUID(),
      sku: '77290',
      name: 'Фільтр масляний MAHLE/Knecht OC196',
      qty_on_hand: 0,
      retail_price: 24000,
    })
    catalog.upsertProduct({
      id: randomUUID(),
      sku: 'UNRELATED',
      name: 'Фільтр масляний іншої моделі',
      qty_on_hand: 10,
      retail_price: 10000,
    })

    const analogs = catalog.listAnalogs(sourceId)
    expect(analogs.map((product) => product.sku)).toEqual(['77829', '77290'])
  })
  it('supersedes obsolete ordinary product updates but keeps the newest value', () => {
    const id = randomUUID()
    const now = new Date().toISOString()
    for (const [index, retailPrice] of [200099879292300, 300, 290].entries()) {
      db.prepare(`
        INSERT INTO sync_outbox (
          operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
          operation_type, payload_json, status, attempts, created_at
        ) VALUES (?, '00000000-0000-0000-0000-000000000001', 'test', 'product', ?,
                  'product.upsert', ?, ?, ?, ?)
      `).run(randomUUID(), id, JSON.stringify({ id, sku: 'P', name: 'P', retail_price: retailPrice }), index === 0 ? 'failed' : 'pending', index === 0 ? 30 : 0, now)
    }

    new LocalSyncRepository(db)
    const active = db.prepare(`
      SELECT payload_json FROM sync_outbox
      WHERE aggregate_id = ? AND status IN ('pending', 'failed')
    `).all(id) as Array<{ payload_json: string }>
    expect(active).toHaveLength(1)
    expect(JSON.parse(active[0].payload_json).retail_price).toBe(290)
  })
})