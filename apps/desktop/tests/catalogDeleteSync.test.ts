import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSyncRepository } from '../src/repositories/syncRepository'

describe('catalog delete synchronization', () => {
  let root = ''
  let db: LocalDatabase
  let catalog: LocalCatalogRepository
  let sync: LocalSyncRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-catalog-delete-sync-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
    sync = new LocalSyncRepository(db)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-catalog-delete-sync-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('excludes pending reference deletions in one tenant without hiding another tenant', () => {
    for (const [table, type, create, list, remove] of [
      ['categories', 'category', (name: string) => catalog.createCategory(name), () => catalog.listCategories(), (id: string) => catalog.deleteCategory(id)],
      ['brands', 'brand', (name: string) => catalog.createBrand(name), () => catalog.listBrands(), (id: string) => catalog.deleteBrand(id)],
    ] as const) {
      const kept = create('Keep')
      const removed = create('Remove')
      remove(removed.id)
      // Simulate a stale active reference while its local deletion is waiting.
      db.prepare('UPDATE ' + table + ' SET deleted_at=NULL WHERE id=?').run(removed.id)
      db.prepare("INSERT INTO sync_outbox(operation_id,tenant_id,device_id,aggregate_type,aggregate_id,operation_type,payload_json,status,created_at) VALUES(?,?,?, ?,?,?, '{}','pending','2026-09-14')")
        .run(randomUUID(), 'other-tenant', db.deviceId, type, kept.id, type + '.deleted')
      expect(list().map(row => row.id)).toContain(kept.id)
      expect(list().map(row => row.id)).not.toContain(removed.id)
      db.prepare("UPDATE sync_outbox SET status='synced' WHERE aggregate_id=?").run(removed.id)
      expect(list().map(row => row.id)).toContain(removed.id)
    }
  })
  function remoteProduct(id: string, updatedAt: string) {
    return {
      id,
      tenant_id: DEFAULT_TENANT_ID,
      sku: `REMOTE-${id.slice(0, 8)}`,
      name: 'Товар з іншого пристрою',
      barcode: '2000000000001',
      unit: 'шт',
      purchase_price: 100,
      retail_price: 200,
      qty_on_hand: 1,
      reorder_point: 0,
      is_active: true,
      is_service: false,
      updated_at: updatedAt,
      created_at: updatedAt,
      deleted_at: null,
    }
  }

  it('restores a clean server tombstone when another device restores the product', () => {
    const id = randomUUID()
    const createdAt = '2026-07-30T10:00:00.000Z'
    sync.applyPullChanges({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: createdAt,
      products: [remoteProduct(id, createdAt)],
    } as any)

    const deletedAt = '2026-07-30T10:01:00.000Z'
    sync.applyPullChanges({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: deletedAt,
      deleted_product_ids: [id],
    } as any)
    expect(catalog.findById(id)).toBeNull()
    expect(db.prepare('SELECT dirty_at FROM products WHERE id = ?').get(id))
      .toEqual({ dirty_at: null })

    const restoredAt = '2026-07-30T10:02:00.000Z'
    sync.applyPullChanges({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: restoredAt,
      products: [remoteProduct(id, restoredAt)],
    } as any)

    expect(catalog.findById(id)).toMatchObject({
      id,
      barcode: '2000000000001',
      qty_on_hand: 1,
    })
    const deleteOperations = db.prepare(`
      SELECT count(*) AS count
      FROM sync_outbox
      WHERE aggregate_id = ? AND operation_type = 'product.deleted' AND status <> 'synced'
    `).get(id) as { count: number }
    expect(deleteOperations.count).toBe(0)
  })

  it('keeps a real pending local deletion when the server still sends an active copy', () => {
    const id = randomUUID()
    const createdAt = '2026-07-30T11:00:00.000Z'
    sync.applyPullChanges({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: createdAt,
      products: [remoteProduct(id, createdAt)],
    } as any)

    catalog.deleteProduct(id)
    expect(catalog.findById(id)).toBeNull()

    const pulledAt = '2026-07-30T11:01:00.000Z'
    sync.applyPullChanges({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: pulledAt,
      products: [remoteProduct(id, pulledAt)],
    } as any)

    expect(catalog.findById(id)).toBeNull()
    const deleteOperations = db.prepare(`
      SELECT count(*) AS count
      FROM sync_outbox
      WHERE aggregate_id = ? AND operation_type = 'product.deleted' AND status <> 'synced'
    `).get(id) as { count: number }
    expect(deleteOperations.count).toBe(1)
  })
})
