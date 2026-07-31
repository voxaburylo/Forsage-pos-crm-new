import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSyncRepository } from '../src/repositories/syncRepository'

describe('desktop sync self-healing', () => {
  let root = ''
  let db: LocalDatabase

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-sync-healing-'))
    db = new LocalDatabase(root)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-sync-healing-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('unblocks a product whose outbox is already fully acknowledged', () => {
    const product = new LocalCatalogRepository(db).upsertProduct({
      id: randomUUID(), sku: 'HEAL-1', name: 'Товар для звірки', qty_on_hand: 3, retail_price: 100,
    })
    const now = new Date().toISOString()
    db.prepare("UPDATE sync_outbox SET status = 'synced', synced_at = ? WHERE aggregate_type = 'product' AND aggregate_id = ?")
      .run(now, product.id)
    db.prepare("INSERT OR REPLACE INTO app_meta(key, value_json, updated_at) VALUES ('desktop_last_reference_sync_at', ?, ?)")
      .run(JSON.stringify(now), now)

    new LocalSyncRepository(db)

    expect(db.prepare('SELECT dirty_at FROM products WHERE id = ?').get(product.id)).toEqual({ dirty_at: null })
    expect(db.prepare("SELECT key FROM app_meta WHERE key = 'desktop_last_reference_sync_at'").get()).toBeUndefined()
  })

  it('retries an exhausted return after the commission reversal constraint is repaired', () => {
    const returnId = randomUUID()
    db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, attempts, last_error, created_at
      ) VALUES (?, '00000000-0000-0000-0000-000000000001', 'test', 'return', ?,
                'return.created', '{}', 'failed', 30, 'Не вдалося сторнувати комісію повернення', ?)
    `).run(randomUUID(), returnId, new Date().toISOString())

    new LocalSyncRepository(db)

    expect(db.prepare('SELECT status, attempts, last_error FROM sync_outbox WHERE aggregate_id = ?').get(returnId))
      .toEqual({ status: 'pending', attempts: 0, last_error: null })
  })
})
