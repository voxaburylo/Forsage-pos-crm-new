import { describe, expect, it, vi } from 'vitest'
import { processSyncBatch, type SyncBatchOperation } from '../syncBatch.js'

function operation(
  sequence: number,
  aggregateType: string,
  aggregateId: string,
  operationType: string,
  payload: any = {},
): SyncBatchOperation {
  return {
    sequence,
    operation_id: `operation-${sequence}`,
    tenant_id: 'tenant-1',
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    operation_type: operationType,
    payload,
  }
}

describe('sync batch isolation', () => {
  it('continues with unrelated operations after one failure', async () => {
    const operations = [
      operation(1, 'product', 'product-a', 'product.upsert'),
      operation(2, 'sale', 'sale-b', 'sale.completed', {
        items: [{ product_id: 'product-b' }],
      }),
    ]
    const apply = vi.fn(async (item: SyncBatchOperation) => {
      if (item.sequence === 1) throw new Error('product failed')
    })

    await expect(processSyncBatch(operations, apply)).resolves.toEqual([
      expect.objectContaining({ sequence: 1, status: 'failed', error: 'product failed' }),
      expect.objectContaining({ sequence: 2, status: 'synced' }),
    ])
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('keeps dependent documents pending until the failed product succeeds', async () => {
    const operations = [
      operation(1, 'product', 'product-a', 'product.upsert'),
      operation(2, 'sale', 'sale-a', 'sale.completed', {
        items: [{ product_id: 'product-a' }],
      }),
      operation(3, 'supply_invoice', 'invoice-a', 'supplier_invoice.created', {
        items: [{ product_id: 'product-a' }],
      }),
      operation(4, 'sale', 'sale-b', 'sale.completed', {
        items: [{ product_id: 'product-b' }],
      }),
    ]
    const apply = vi.fn(async (item: SyncBatchOperation) => {
      if (item.sequence === 1) throw new Error('product failed')
    })

    const results = await processSyncBatch(operations, apply)

    expect(results.map((result) => result.sequence)).toEqual([1, 4])
    expect(apply.mock.calls.map(([item]) => item.sequence)).toEqual([1, 4])
  })
})
