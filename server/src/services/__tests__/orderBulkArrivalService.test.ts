import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMock = vi.hoisted(() => ({ runTransaction: vi.fn() }))

vi.mock('../../db/pg.js', () => ({ runTransaction: pgMock.runTransaction }))

import { markOrderItemsArrived } from '../orderBulkArrivalService.js'

function installTransaction(rows: Array<{ id: string; order_id: string; product_id: string | null }>) {
  let updated = false
  let parentTouched = false
  const query = vi.fn(async (sqlValue: string) => {
    const sql = String(sqlValue).replace(/\s+/g, ' ').trim()
    if (sql.startsWith('SELECT i.id')) return { rowCount: rows.length, rows }
    if (sql.startsWith('UPDATE customer_order_items')) {
      updated = true
      return { rowCount: rows.length, rows }
    }
    if (sql.startsWith('UPDATE customer_orders')) {
      parentTouched = true
      return { rowCount: new Set(rows.map((row) => row.order_id)).size, rows: [] }
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  })
  pgMock.runTransaction.mockImplementation(async (callback: (client: { query: typeof query }) => unknown) =>
    callback({ query }),
  )
  return { query, wasUpdated: () => updated, wasParentTouched: () => parentTouched }
}

describe('markOrderItemsArrived tenant isolation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('updates all positions only after tenant ownership was verified', async () => {
    const rows = [
      { id: '11111111-1111-4111-8111-111111111111', order_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', product_id: null },
      { id: '22222222-2222-4222-8222-222222222222', order_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', product_id: null },
    ]
    const transaction = installTransaction(rows)

    await expect(markOrderItemsArrived({
      tenant_id: '33333333-3333-4333-8333-333333333333',
      item_ids: rows.map((row) => row.id),
    })).resolves.toEqual(rows)
    expect(transaction.wasUpdated()).toBe(true)
    expect(transaction.wasParentTouched()).toBe(true)
  })

  it('rejects a mixed-tenant or missing id before the update', async () => {
    const transaction = installTransaction([
      { id: '11111111-1111-4111-8111-111111111111', order_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', product_id: null },
    ])

    await expect(markOrderItemsArrived({
      tenant_id: '33333333-3333-4333-8333-333333333333',
      item_ids: [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ],
    })).rejects.toMatchObject({ code: 'ORDER_ITEMS_NOT_FOUND', status: 404 })
    expect(transaction.wasUpdated()).toBe(false)
  })
})
