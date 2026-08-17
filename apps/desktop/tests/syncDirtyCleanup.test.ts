import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSyncRepository } from '../src/repositories/syncRepository'

describe('outbox dirty flag cleanup', () => {
  let root = ''
  let db: LocalDatabase
  let catalog: LocalCatalogRepository
  let sync: LocalSyncRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-dirty-cleanup-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
    sync = new LocalSyncRepository(db)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-dirty-cleanup-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(['pending', 'failed'] as const)(
    'does not clear dirty_at while a newer %s operation exists for the aggregate',
    (blockingStatus) => {
      const product = catalog.saveProduct({
        id: randomUUID(),
        sku: `DIRTY-${randomUUID().slice(0, 8)}`,
        name: 'Dirty cleanup product',
      })
      const first = db.prepare(`
        SELECT sequence, operation_id, payload_json, created_at
        FROM sync_outbox
        WHERE aggregate_type = 'product' AND aggregate_id = ?
        ORDER BY sequence ASC LIMIT 1
      `).get(product.id) as {
        sequence: number
        operation_id: string
        payload_json: string
        created_at: string
      }
      const secondId = randomUUID()
      db.prepare(`
        INSERT INTO sync_outbox (
          operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
          operation_type, payload_json, status, attempts, created_at
        ) VALUES (?, ?, ?, 'product', ?, 'product.upsert', ?, ?, ?, ?)
      `).run(
        secondId,
        DEFAULT_TENANT_ID,
        db.deviceId,
        product.id,
        first.payload_json,
        blockingStatus,
        blockingStatus === 'failed' ? 1 : 0,
        first.created_at,
      )
      const second = db.prepare('SELECT sequence FROM sync_outbox WHERE operation_id = ?')
        .get(secondId) as { sequence: number }

      sync.applyPushResults([{ sequence: first.sequence, operation_id: first.operation_id, status: 'synced' }])
      const blocked = db.prepare('SELECT dirty_at FROM products WHERE id = ?').get(product.id) as { dirty_at: string | null }
      expect(blocked.dirty_at).not.toBeNull()

      sync.applyPushResults([{ sequence: second.sequence, operation_id: secondId, status: 'synced' }])
      const cleared = db.prepare('SELECT dirty_at FROM products WHERE id = ?').get(product.id) as { dirty_at: string | null }
      expect(cleared.dirty_at).toBeNull()
    },
  )
  it('repairs dirty rows left behind by an already acknowledged operation', () => {
    const timestamp = new Date().toISOString()
    const cashierId = randomUUID()
    const shiftId = randomUUID()
    const saleId = randomUUID()
    const product = catalog.upsertProduct({
      id: randomUUID(),
      sku: `RECOVER-${randomUUID().slice(0, 8)}`,
      name: 'Recovered stock row',
      qty_on_hand: 3,
      purchase_price: 10,
      retail_price: 20,
    })
    db.prepare(`
      INSERT INTO shifts (
        id, tenant_id, cashier_id, status, opening_cash,
        opened_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'open', 0, ?, ?, ?)
    `).run(shiftId, DEFAULT_TENANT_ID, cashierId, timestamp, timestamp, timestamp)
    db.prepare(`
      INSERT INTO sales (
        id, tenant_id, sale_number, cashier_id, shift_id, status,
        subtotal, total, payment_method, dirty_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'completed', 20, 20, 'cash', ?, ?, ?, ?)
    `).run(
      saleId,
      DEFAULT_TENANT_ID,
      `RECOVER-${saleId.slice(0, 8)}`,
      cashierId,
      shiftId,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
    )
    db.prepare(`
      INSERT INTO inventory_movements (
        id, tenant_id, product_id, source_type, source_id, qty_delta, qty_after,
        dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'sale', ?, -1, 2, ?, ?, ?)
    `).run(randomUUID(), DEFAULT_TENANT_ID, product.id, saleId, timestamp, timestamp, timestamp)
    db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, attempts, created_at, synced_at
      ) VALUES (?, ?, ?, 'sale', ?, 'sale.completed', ?, 'synced', 0, ?, ?)
    `).run(
      randomUUID(),
      DEFAULT_TENANT_ID,
      db.deviceId,
      saleId,
      JSON.stringify({ items: [{ product_id: product.id }] }),
      timestamp,
      timestamp,
    )

    new LocalSyncRepository(db)

    expect(db.prepare('SELECT dirty_at FROM sales WHERE id = ?').get(saleId))
      .toEqual({ dirty_at: null })
    expect(db.prepare('SELECT dirty_at FROM inventory_movements WHERE source_id = ?').get(saleId))
      .toEqual({ dirty_at: null })
  })
  it('clears a stale dirty flag from a completed returned sale', () => {
    const timestamp = new Date().toISOString()
    const saleId = randomUUID()
    const returnId = randomUUID()
    const shiftId = randomUUID()
    db.prepare('INSERT INTO shifts (id, tenant_id, cashier_id, status, opening_cash, opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(shiftId, DEFAULT_TENANT_ID, randomUUID(), 'open', 0, timestamp, timestamp, timestamp)
    db.prepare(`
      INSERT INTO sales (
        id, tenant_id, sale_number, cashier_id, shift_id, status,
        subtotal, total, payment_method, dirty_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'returned', 20, 20, 'cash', ?, ?, ?, ?)
    `).run(
      saleId,
      DEFAULT_TENANT_ID,
      `RETURNED-${saleId.slice(0, 8)}`,
      randomUUID(),
      shiftId,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
    )
    db.prepare(`
      INSERT INTO customer_returns (
        id, tenant_id, sale_id, reason, refund_method, stock_action,
        refund_kopecks, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'customer_request', 'cash', 'no_return', 0, 'completed', ?, ?)
    `).run(returnId, DEFAULT_TENANT_ID, saleId, timestamp, timestamp)

    new LocalSyncRepository(db)

    expect(db.prepare('SELECT dirty_at FROM sales WHERE id = ?').get(saleId))
      .toEqual({ dirty_at: null })
  })
  it('treats a reset-discarded operation as terminal without clearing its dirty row', () => {
    const product = catalog.saveProduct({
      id: randomUUID(),
      sku: `DISCARDED-${randomUUID().slice(0, 8)}`,
      name: 'Discarded generation product',
    })
    const operation = db.prepare(`
      SELECT sequence, operation_id
      FROM sync_outbox
      WHERE aggregate_type = 'product' AND aggregate_id = ?
      ORDER BY sequence ASC LIMIT 1
    `).get(product.id) as { sequence: number; operation_id: string }

    sync.applyPushResults([{
      sequence: operation.sequence,
      operation_id: operation.operation_id,
      status: 'discarded',
      error_code: 'SYNC_RESET_REQUIRED',
      reset_generation: 4,
    }])

    expect(db.prepare('SELECT status FROM sync_outbox WHERE sequence = ?').get(operation.sequence))
      .toEqual({ status: 'synced' })
    expect(db.prepare('SELECT dirty_at FROM products WHERE id = ?').get(product.id))
      .toEqual(expect.objectContaining({ dirty_at: expect.any(String) }))
    expect(sync.listPending()).toEqual([])
  })

})
