import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMock = vi.hoisted(() => ({
  runTransaction: vi.fn(),
}))

vi.mock('../../db/pg.js', () => ({
  runTransaction: pgMock.runTransaction,
}))

import { addOrderPayment } from '../orderPaymentService.js'

type TestState = {
  order: Record<string, unknown>
  payments: Map<string, Record<string, unknown>>
  cashOperations: Map<string, Record<string, unknown>>
  accountTransactions: Map<string, Record<string, unknown>>
  customerBalance: number
  shiftOpen: boolean
}

function createState(): TestState {
  return {
    order: {
      id: '11111111-1111-4111-8111-111111111111',
      tenant_id: '22222222-2222-4222-8222-222222222222',
      status: 'in_progress',
      total_amount: 10_000,
      discount_amount: 0,
      total_paid: 0,
      prepayment: 0,
      customer_id: '55555555-5555-4555-8555-555555555555',
      order_number: 42,
    },
    payments: new Map(),
    cashOperations: new Map(),
    accountTransactions: new Map(),
    customerBalance: 8_000,
    shiftOpen: true,
  }
}

function installFakeTransaction(state: TestState) {
  const query = vi.fn(async (queryText: string, params: unknown[] = []) => {
    const sql = String(queryText).replace(/\s+/g, ' ').trim()
    if (sql.startsWith('SELECT id, tenant_id, status') && sql.includes('FROM customer_orders')) {
      return { rowCount: 1, rows: [{ ...state.order }] }
    }
    if (sql.startsWith('SELECT * FROM order_payments')) {
      const payment = state.payments.get(String(params[0]))
      return { rowCount: payment ? 1 : 0, rows: payment ? [{ ...payment }] : [] }
    }
    if (sql.startsWith('SELECT id FROM shifts')) {
      return state.shiftOpen
        ? { rowCount: 1, rows: [{ id: params[0] }] }
        : { rowCount: 0, rows: [] }
    }
    if (sql.startsWith('SELECT id, COALESCE(deposit_balance')) {
      return { rowCount: 1, rows: [{ id: state.order.customer_id, deposit_balance: state.customerBalance }] }
    }
    if (sql.startsWith('UPDATE customers')) {
      state.customerBalance = Number(params[2])
      return { rowCount: 1, rows: [] }
    }
    if (sql.startsWith('INSERT INTO customer_deposit_transactions')) {
      state.accountTransactions.set(String(params[0]), { id: params[0], amount: params[3] })
      return { rowCount: 1, rows: [] }
    }
    if (sql.startsWith('INSERT INTO order_payments')) {
      const payment = {
        id: params[0],
        tenant_id: params[1],
        order_id: params[2],
        amount: params[3],
        method: params[4],
        is_fiscal: params[5],
        shift_id: params[6],
      }
      state.payments.set(String(params[0]), payment)
      return { rowCount: 1, rows: [{ ...payment }] }
    }
    if (sql.startsWith('UPDATE customer_orders')) {
      state.order.total_paid = params[2]
      state.order.status = params[3]
      return { rowCount: 1, rows: [] }
    }
    if (sql.startsWith('INSERT INTO cash_operations')) {
      state.cashOperations.set(String(params[0]), { id: params[0], amount: params[3] })
      return { rowCount: 1, rows: [] }
    }
    if (sql.startsWith('INSERT INTO order_activity_log')) {
      return { rowCount: 1, rows: [] }
    }
    throw new Error(`Unexpected SQL in test: ${sql}`)
  })
  pgMock.runTransaction.mockImplementation(async (callback: (client: { query: typeof query }) => unknown) =>
    callback({ query }),
  )
  return query
}

const baseInput = {
  payment_id: '33333333-3333-4333-8333-333333333333',
  order_id: '11111111-1111-4111-8111-111111111111',
  tenant_id: '22222222-2222-4222-8222-222222222222',
  user_id: '44444444-4444-4444-8444-444444444444',
  amount: 2_000,
  method: 'cash' as const,
  is_fiscal: false,
  shift_id: '66666666-6666-4666-8666-666666666666',
}

describe('addOrderPayment idempotency', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the first payment on retry without a second cash movement', async () => {
    const state = createState()
    installFakeTransaction(state)

    const first = await addOrderPayment(baseInput)
    state.order.status = 'completed'
    const retry = await addOrderPayment(baseInput)

    expect(first.replayed).toBe(false)
    expect(retry.replayed).toBe(true)
    expect(state.payments.size).toBe(1)
    expect(state.cashOperations.size).toBe(1)
    expect(state.order.total_paid).toBe(2_000)
  })

  it('rejects reusing the payment id with different money', async () => {
    const state = createState()
    installFakeTransaction(state)
    await addOrderPayment(baseInput)

    await expect(addOrderPayment({ ...baseInput, amount: 2_001 })).rejects.toMatchObject({
      code: 'PAYMENT_ID_REUSED',
      status: 409,
    })
  })

  it('requires an open shift for a cash payment', async () => {
    const state = createState()
    state.shiftOpen = false
    installFakeTransaction(state)

    await expect(addOrderPayment({ ...baseInput, shift_id: null })).rejects.toMatchObject({
      code: 'OPEN_SHIFT_REQUIRED',
    })
    expect(state.payments.size).toBe(0)
    expect(state.cashOperations.size).toBe(0)
  })

  it('rejects payments for a canceled order before recording movement', async () => {
    const state = createState()
    state.order.status = 'canceled'
    installFakeTransaction(state)

    await expect(addOrderPayment(baseInput)).rejects.toMatchObject({
      code: 'PAYMENT_NOT_ALLOWED',
    })
    expect(state.payments.size).toBe(0)
    expect(state.cashOperations.size).toBe(0)
  })

  it('deducts an account payment and writes its journal once', async () => {
    const state = createState()
    installFakeTransaction(state)
    const input = { ...baseInput, method: 'account' as const }

    await addOrderPayment(input)
    await addOrderPayment(input)

    expect(state.customerBalance).toBe(6_000)
    expect(state.accountTransactions.size).toBe(1)
    expect(state.cashOperations.size).toBe(0)
    expect(state.payments.size).toBe(1)
  })
})
