import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const syncSource = readFileSync(new URL('../syncService.ts', import.meta.url), 'utf8')
const customerSource = readFileSync(new URL('../customerService.ts', import.meta.url), 'utf8')
const saleSource = readFileSync(new URL('../saleService.ts', import.meta.url), 'utf8')
const commissionSource = readFileSync(new URL('../commissionService.ts', import.meta.url), 'utf8')
const salaryRouteSource = readFileSync(new URL('../../routes/salary.ts', import.meta.url), 'utf8')
const authRouteSource = readFileSync(new URL('../../routes/auth.ts', import.meta.url), 'utf8')
const deletionMigration = readFileSync(
  new URL('../../../../supabase/migrations/20260729090000_sync_deletion_log.sql', import.meta.url),
  'utf8',
)

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

  it('publishes salary and cash deletion tombstones to every local device', () => {
    expect(syncSource).toContain(".from('sync_deletions')")
    expect(syncSource).toContain('deleted_salary_payment_ids: deletedSalaryPayments.map')
    expect(syncSource).toContain('deleted_cash_operation_ids: deletedCashOperations.map')
    expect(syncSource).toContain("VALUES ($1, 'salary_payment', $2, $3)")
    expect(syncSource).toContain("VALUES ($1, 'cash_operation', $2, $3)")
    expect(salaryRouteSource).toContain('SELECT cash_operation_id, source FROM salary_payments')
    expect(salaryRouteSource).toContain('AUTOMATIC_SALARY_IMMUTABLE')
    expect(salaryRouteSource).toContain("VALUES ($1, 'cash_operation', $2, NOW())")
    expect(deletionMigration).toContain('CREATE TABLE IF NOT EXISTS sync_deletions')
    expect(deletionMigration).toContain('TO authenticated')
  })
  it('syncs staff PINs only as tenant-scoped protected hashes', () => {
    const start = syncSource.indexOf('async function applyStaffPinUpdated')
    const end = syncSource.indexOf('async function applyStaffUserUpsert', start)
    const block = syncSource.slice(start, end)
    expect(block).toContain('/^[0-9a-f]{128}$/i.test(pinHash)')
    expect(block).toContain('getUserById(userId)')
    expect(block).toContain("existing.user.app_metadata?.tenant_id !== tenantId")
    expect(syncSource).toContain(".from('staff_pins')")
    expect(syncSource).toContain("staffPins.push({ user_id: row.user_id, pin_hash: pinHash")
    expect(authRouteSource).toContain("regex(/^\\d{4}$/")
    expect(authRouteSource).toContain('getUserById(targetUserId)')
    expect(authRouteSource).toContain("targetUser.user.app_metadata?.tenant_id !== req.user!.tenant_id")
    expect(authRouteSource).toContain("if (pinError) throw new AppError('DB_ERROR'")
  })
  it('updates web manual bonuses atomically under a customer row lock', () => {
    const start = customerSource.indexOf('export async function manualBonus')
    const block = customerSource.slice(start)
    expect(block).toContain('LIMIT 1 FOR UPDATE')
    expect(block).toContain("throw new AppError('INSUFFICIENT_BONUS'")
    expect(block).toContain('INSERT INTO bonus_transactions')
  })
  it('keeps customer cash, balance and audit writes in one database transaction', () => {
    const debtStart = customerSource.indexOf('export async function payDebt')
    const depositStart = customerSource.indexOf('export async function topUpDeposit')
    const vehicleStart = customerSource.indexOf('// ===================== VEHICLES', depositStart)
    const debtBlock = customerSource.slice(debtStart, depositStart)
    const depositBlock = customerSource.slice(depositStart, vehicleStart)
    for (const block of [debtBlock, depositBlock]) {
      expect(block).toContain('return runTransaction')
      expect(block).toContain('INSERT INTO cash_operations')
      expect(block).toContain('INSERT INTO audit_log')
      expect(block).toContain('user_name')
      expect(block).not.toContain('entity_id, details')
    }
  })

  it('records sale commission atomically and gives return reversals deterministic ids', () => {
    expect(saleSource).toContain('const useBonusAtomic = true')
    expect(saleSource).toContain('computeCommissionMap(')
    expect(saleSource).toContain('INSERT INTO salary_payments')
    expect(commissionSource).toContain("update(`commission-reversal:${returnId}:${employeeId}`)")
    expect(commissionSource).toContain('commission_source_return_id: returnId')
    const salaryStart = syncSource.indexOf('async function applySalaryPaymentCreated')
    const salaryEnd = syncSource.indexOf('async function applySalaryPaymentDeleted', salaryStart)
    expect(syncSource.slice(salaryStart, salaryEnd)).toContain('ON CONFLICT DO NOTHING')
  })

})