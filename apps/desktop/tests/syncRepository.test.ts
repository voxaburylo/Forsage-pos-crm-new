import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalSyncRepository } from '../src/repositories/syncRepository'

describe('LocalSyncRepository.listPending', () => {
  let root = ''
  let db: LocalDatabase
  let repository: LocalSyncRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-sync-outbox-'))
    db = new LocalDatabase(root)
    repository = new LocalSyncRepository(db)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-sync-outbox-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function insertOperation(input: {
    aggregateType: string
    aggregateId: string
    operationType: string
    payload: unknown
    status?: 'pending' | 'failed'
    nextAttemptAt?: string | null
  }): string {
    const operationId = randomUUID()
    db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, attempts, next_attempt_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      operationId,
      DEFAULT_TENANT_ID,
      db.deviceId,
      input.aggregateType,
      input.aggregateId,
      input.operationType,
      JSON.stringify(input.payload),
      input.status ?? 'pending',
      input.status === 'failed' ? 1 : 0,
      input.nextAttemptAt ?? null,
      new Date().toISOString(),
    )
    return operationId
  }

  it('does not let a delayed product retry freeze an independent new sale', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    insertOperation({
      aggregateType: 'product', aggregateId: 'product-delayed', operationType: 'product.upsert',
      payload: { id: 'product-delayed' }, status: 'failed', nextAttemptAt: future,
    })
    const dependent = insertOperation({
      aggregateType: 'sale', aggregateId: 'sale-dependent', operationType: 'sale.completed',
      payload: { items: [{ product_id: 'product-delayed' }] },
    })
    const independent = insertOperation({
      aggregateType: 'sale', aggregateId: 'sale-independent', operationType: 'sale.completed',
      payload: { items: [{ product_id: 'product-ready' }] },
    })

    expect(repository.listPending(10).map((row) => row.operation_id)).toEqual([dependent, independent])
  })

  it('does not hide completed receipts behind a failed old count of the same product', () => {
    insertOperation({ aggregateType: 'inventory_session', aggregateId: 'old-count',
      operationType: 'inventory.completed', payload: { items: [{ product_id: 'p1' }] },
      status: 'failed', nextAttemptAt: new Date(Date.now() + 60_000).toISOString() })
    const receipt = insertOperation({ aggregateType: 'sale', aggregateId: 'receipt',
      operationType: 'sale.completed', payload: { items: [{ product_id: 'p1' }] } })
    expect(repository.listPending(10).map(row => row.operation_id)).toEqual([receipt])
  })

  it('does not let one failed receipt block another receipt for the same product', () => {
    insertOperation({ aggregateType: 'sale', aggregateId: 'old-sale', operationType: 'sale.completed',
      payload: { items: [{ product_id: 'p1' }] }, status: 'failed',
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString() })
    const receipt = insertOperation({ aggregateType: 'sale', aggregateId: 'new-sale',
      operationType: 'sale.completed', payload: { items: [{ product_id: 'p1' }] } })
    expect(repository.listPending(10).map(row => row.operation_id)).toEqual([receipt])
  })

  it('preserves supplier and invoice dependency order without blocking another supplier', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    insertOperation({
      aggregateType: 'supplier', aggregateId: 'supplier-delayed', operationType: 'supplier.created',
      payload: { id: 'supplier-delayed' }, status: 'failed', nextAttemptAt: future,
    })
    insertOperation({
      aggregateType: 'supply_invoice', aggregateId: 'invoice-dependent', operationType: 'supplier_invoice.created',
      payload: { supplier_id: 'supplier-delayed', items: [] },
    })
    const independent = insertOperation({
      aggregateType: 'supply_invoice', aggregateId: 'invoice-independent', operationType: 'supplier_invoice.created',
      payload: { supplier_id: 'supplier-ready', items: [] },
    })

    expect(repository.listPending(10).map((row) => row.operation_id)).toEqual([independent])
  })

  it('keeps later operations of the same aggregate behind a failed retry', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    insertOperation({
      aggregateType: 'order', aggregateId: 'order-one', operationType: 'order.created',
      payload: { id: 'order-one' }, status: 'failed', nextAttemptAt: future,
    })
    insertOperation({
      aggregateType: 'order', aggregateId: 'order-one', operationType: 'order.updated',
      payload: { id: 'order-one' },
    })
    const independent = insertOperation({
      aggregateType: 'customer', aggregateId: 'customer-two', operationType: 'customer.updated',
      payload: { id: 'customer-two' },
    })

    expect(repository.listPending(10).map((row) => row.operation_id)).toEqual([independent])
  })

  it('sends fresh independent work before retrying an old due failure', () => {
    const oldFailure = insertOperation({
      aggregateType: 'customer', aggregateId: 'customer-old', operationType: 'customer.updated',
      payload: { id: 'customer-old' }, status: 'failed', nextAttemptAt: new Date(0).toISOString(),
    })
    const freshSale = insertOperation({
      aggregateType: 'sale', aggregateId: 'sale-new', operationType: 'sale.completed',
      payload: { items: [] },
    })

    expect(repository.listPending(10).map((row) => row.operation_id)).toEqual([freshSale, oldFailure])
  })
})
