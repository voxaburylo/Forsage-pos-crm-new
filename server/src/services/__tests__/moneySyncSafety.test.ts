import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const syncSource = readFileSync(new URL('../syncService.ts', import.meta.url), 'utf8')
const customerSource = readFileSync(new URL('../customerService.ts', import.meta.url), 'utf8')

describe('money synchronization safety', () => {
  it('uses deterministic cash operation ids for debt and deposit sync', () => {
    expect(syncSource).toContain('isUuid(payload.cash_operation_id) ? payload.cash_operation_id : operation.operation_id')
    expect(syncSource).toContain('INSERT INTO cash_operations (id, tenant_id, shift_id, type, amount, note, created_by, created_at)')
    expect(syncSource).toContain('ON CONFLICT (id) DO NOTHING')
  })

  it('keeps balance fields out of ordinary customer profile conflict resolution', () => {
    const start = syncSource.indexOf('async function applyCustomerUpsert')
    const end = syncSource.indexOf('async function applyCustomerDeleted', start)
    const block = syncSource.slice(start, end)
    expect(block).toContain('debt_balance: existing.debt_balance')
    expect(block).toContain('deposit_balance: existing.deposit_balance')
    expect(block).toContain('bonus_balance: existing.bonus_balance')
    expect(block).not.toContain("hasOwnProperty.call(incomingPayload, 'bonus_balance')")
  })

  it('applies manual bonus changes as tenant-scoped idempotent deltas', () => {
    const start = syncSource.indexOf('async function applyCustomerBonusAdjusted')
    const end = syncSource.indexOf('async function applyOrderPaymentAdded', start)
    const block = syncSource.slice(start, end)
    expect(block).toContain('SELECT id, tenant_id FROM bonus_transactions')
    expect(block).toContain('bonus_balance = COALESCE(bonus_balance, 0) + $1')
    expect(block).toContain("SYNC_BONUS_TENANT_CONFLICT")
  })

  it('updates web manual bonuses atomically under a customer row lock', () => {
    const start = customerSource.indexOf('export async function manualBonus')
    const block = customerSource.slice(start)
    expect(block).toContain('LIMIT 1 FOR UPDATE')
    expect(block).toContain("throw new AppError('INSUFFICIENT_BONUS'")
    expect(block).toContain('INSERT INTO bonus_transactions')
  })
})