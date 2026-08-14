import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMock = vi.hoisted(() => ({ runTransaction: vi.fn() }))
vi.mock('../../db/pg.js', () => ({ runTransaction: pgMock.runTransaction }))
vi.mock('../../db/supabase.js', () => ({ db: {} }))

import { payOutDeposit } from '../customerService.js'

const customerId = '11111111-1111-4111-8111-111111111111'
const tenantId = '22222222-2222-4222-8222-222222222222'
const userId = '33333333-3333-4333-8333-333333333333'
const payoutId = '44444444-4444-4444-8444-444444444444'
const shiftId = '55555555-5555-4555-8555-555555555555'

function installTransaction(options: { balance?: number; existing?: boolean } = {}) {
  const writes: Array<{ sql: string; params: unknown[] }> = []
  const query = vi.fn(async (sqlValue: string, params: unknown[] = []) => {
    const sql = String(sqlValue).replace(/\s+/g, ' ').trim()
    if (sql.startsWith('SELECT tenant_id, customer_id, amount')) {
      return options.existing
        ? { rowCount: 1, rows: [{ tenant_id: tenantId, customer_id: customerId, amount: -400, balance_after: 600 }] }
        : { rowCount: 0, rows: [] }
    }
    if (sql.startsWith('SELECT id, full_name, phone')) {
      return { rowCount: 1, rows: [{ id: customerId, full_name: 'Клієнт', phone: '+380500000000', deposit_balance: options.balance ?? 1_000 }] }
    }
    if (sql.startsWith('SELECT id FROM shifts')) return { rowCount: 1, rows: [{ id: shiftId }] }
    writes.push({ sql, params })
    return { rowCount: 1, rows: [] }
  })
  pgMock.runTransaction.mockImplementation(async (callback: (client: { query: typeof query }) => unknown) => callback({ query }))
  return writes
}

describe('payOutDeposit', () => {
  beforeEach(() => vi.clearAllMocks())

  it('decrements one customer balance and records a cash out in the same transaction', async () => {
    const writes = installTransaction()
    const result = await payOutDeposit(customerId, {
      payout_id: payoutId, amount: 400, method: 'cash', shift_id: shiftId,
    }, userId, tenantId)

    expect(result).toEqual({ balance: 600, replayed: false })
    const ledger = writes.find((write) => write.sql.startsWith('INSERT INTO customer_deposit_transactions'))
    expect(ledger?.params).toContain(-400)
    expect(ledger?.params).toContain(600)
    const cash = writes.find((write) => write.sql.startsWith('INSERT INTO cash_operations'))
    expect(cash?.sql).toContain("'out'")
    expect(cash?.params).toContain(400)
  })

  it('rejects a payout larger than the available account balance', async () => {
    const writes = installTransaction({ balance: 300 })
    await expect(payOutDeposit(customerId, {
      payout_id: payoutId, amount: 400, method: 'cash', shift_id: shiftId,
    }, userId, tenantId)).rejects.toMatchObject({ code: 'INSUFFICIENT_DEPOSIT' })
    expect(writes).toEqual([])
  })

  it('replays the same payout id without decrementing the balance twice', async () => {
    const writes = installTransaction({ existing: true })
    await expect(payOutDeposit(customerId, {
      payout_id: payoutId, amount: 400, method: 'cash', shift_id: shiftId,
    }, userId, tenantId)).resolves.toEqual({ balance: 600, replayed: true })
    expect(writes).toEqual([])
  })
})
