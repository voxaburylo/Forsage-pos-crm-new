import { describe, expect, it } from 'vitest'
import type { LocalSyncPullChanges } from '../src/db/localTypes'
import { createPullChangeChunks } from '../src/repositories/syncPullPlanner'

describe('desktop pull chunk planner', () => {
  it('bounds a large catalog response and never forwards snapshot-reset flags to a data chunk', () => {
    const changes: LocalSyncPullChanges = {
      cursor: '2026-08-01T10:00:00.000Z',
      references_included: true,
      products: Array.from({ length: 205 }, (_, index) => ({
        id: `product-${index}`,
        sku: `SKU-${index}`,
        name: `Product ${index}`,
      })),
    }

    const chunks = createPullChangeChunks(changes, 100)
    const productChunks = chunks.filter((chunk) => chunk.products?.length)

    expect(productChunks.map((chunk) => chunk.products?.length)).toEqual([100, 100, 5])
    expect(chunks.every((chunk) => chunk.references_included === false)).toBe(true)
  })

  it('keeps each changed document and all of its children in one transaction chunk', () => {
    const changes: LocalSyncPullChanges = {
      cursor: '2026-08-01T10:00:00.000Z',
      customer_orders: [
        { id: 'order-a' },
        { id: 'order-b' },
      ],
      customer_order_items: [
        { id: 'item-a1', order_id: 'order-a' },
        { id: 'item-a2', order_id: 'order-a' },
        { id: 'item-b1', order_id: 'order-b' },
      ],
      order_payments: [
        { id: 'payment-a', order_id: 'order-a' },
        { id: 'payment-b', order_id: 'order-b' },
      ],
    }

    const documentChunk = createPullChangeChunks(changes, 1)
      .find((chunk) => chunk.customer_orders?.[0]?.id === 'order-a')

    expect(documentChunk?.customer_order_items?.map((row) => row.id)).toEqual(['item-a1', 'item-a2'])
    expect(documentChunk?.order_payments?.map((row) => row.id)).toEqual(['payment-a'])
  })
})
