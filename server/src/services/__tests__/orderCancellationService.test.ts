import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMock = vi.hoisted(() => ({ runTransaction: vi.fn() }))
vi.mock('../../db/pg.js', () => ({ runTransaction: pgMock.runTransaction }))

import { cancelOrderSafely } from '../orderCancellationService.js'

const input = {
  order_id: '11111111-1111-4111-8111-111111111111',
  tenant_id: '22222222-2222-4222-8222-222222222222',
  user_id: '33333333-3333-4333-8333-333333333333',
  refund_prepayment: false,
  keep_as_credit: false,
  created_at: '2026-07-22T10:00:00.000Z',
}

function installTransaction(options: { status?: string; totalPaid?: number; ledgerPaid?: number; customerId?: string | null; existingCredit?: boolean } = {}) {
  const mutations: string[] = []
  const order = {
    id: input.order_id,
    tenant_id: input.tenant_id,
    status: options.status ?? 'in_progress',
    total_paid: options.totalPaid ?? 2_000,
    prepayment: 0,
    customer_id: options.customerId === undefined ? '44444444-4444-4444-8444-444444444444' : options.customerId,
    order_number: 42,
    comment: null,
  }
  const query = vi.fn(async (sqlValue: string) => {
    const sql = String(sqlValue).replace(/\s+/g, ' ').trim()
    if (sql.startsWith('SELECT id, tenant_id, status')) return { rowCount: 1, rows: [{ ...order }] }
    if (sql.startsWith('SELECT COALESCE(SUM(amount)')) {
      return { rowCount: 1, rows: [{ paid_amount: options.ledgerPaid ?? order.total_paid }] }
    }
    if (sql.startsWith('SELECT amount, balance_after')) {
      const exists = options.existingCredit ?? order.status === 'canceled'
      return exists
        ? { rowCount: 1, rows: [{ amount: order.total_paid, balance_after: 2_500 }] }
        : { rowCount: 0, rows: [] }
    }
    if (sql.startsWith('SELECT id, COALESCE(deposit_balance')) {
      return { rowCount: 1, rows: [{ id: order.customer_id, deposit_balance: 500 }] }
    }
    if (sql.startsWith('UPDATE customers')) {
      mutations.push('customer_balance')
      return { rowCount: 1, rows: [] }
    }
    if (sql.startsWith('INSERT INTO customer_deposit_transactions')) {
      mutations.push('customer_credit')
      return { rowCount: 1, rows: [] }
    }
    if (sql.startsWith('UPDATE customer_orders')) {
      mutations.push('order')
      return { rowCount: 1, rows: [{ ...order, status: 'canceled' }] }
    }
    if (sql.startsWith('UPDATE inventory_reserves')) { mutations.push('reserves'); return { rowCount: 1, rows: [] } }
    if (sql.startsWith('UPDATE customer_order_items')) { mutations.push('items'); return { rowCount: 1, rows: [] } }
    if (sql.startsWith('INSERT INTO order_activity_log')) { mutations.push('activity'); return { rowCount: 1, rows: [] } }
    throw new Error(`Unexpected SQL: ${sql}`)
  })
  pgMock.runTransaction.mockImplementation(async (callback: (client: { query: typeof query }) => unknown) =>
    callback({ query }),
  )
  return mutations
}

describe('cancelOrderSafely', () => {
  beforeEach(() => vi.clearAllMocks())

  it('cancels atomically and credits the immutable payment to the customer account', async () => {
    const mutations = installTransaction()
    const result = await cancelOrderSafely(input)

    expect(result.order_after.status).toBe('canceled')
    expect(result.paid_amount).toBe(2_000)
    expect(result.credited_amount).toBe(2_000)
    expect(result.customer_balance).toBe(2_500)
    expect(mutations).toEqual(['customer_balance', 'customer_credit', 'order', 'reserves', 'items', 'activity'])
  })

  it('blocks an unconfirmed refund before changing the order', async () => {
    const mutations = installTransaction()

    await expect(cancelOrderSafely({ ...input, refund_prepayment: true })).rejects.toMatchObject({
      code: 'FINANCIAL_CANCEL_IN_POS_ONLY',
      status: 409,
    })
    expect(mutations).toEqual([])
  })

  it('requires a customer before moving a paid cancellation to an account', async () => {
    const mutations = installTransaction({ customerId: null })
    await expect(cancelOrderSafely(input)).rejects.toMatchObject({
      code: 'ORDER_CUSTOMER_REQUIRED_FOR_CREDIT',
      status: 422,
    })
    expect(mutations).toEqual([])
  })

  it('replays an already canceled order without duplicate activity', async () => {
    const mutations = installTransaction({ status: 'canceled' })
    const result = await cancelOrderSafely(input)

    expect(result.replayed).toBe(true)
    expect(mutations).toEqual([])
  })
})
