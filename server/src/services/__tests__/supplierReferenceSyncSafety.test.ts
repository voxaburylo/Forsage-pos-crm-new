import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const syncSource = readFileSync(new URL('../syncService.ts', import.meta.url), 'utf8')
const supplierSource = readFileSync(new URL('../supplierService.ts', import.meta.url), 'utf8')
const migration = readFileSync(
  new URL('../../../../supabase/migrations/20260729120000_supplier_payment_sync_timestamp.sql', import.meta.url),
  'utf8',
)

describe('supplier reference synchronization safety', () => {
  it('pulls changed historical supplier payments by updated_at', () => {
    const start = syncSource.indexOf(".from('supplier_payments')")
    const end = syncSource.indexOf(': Promise.resolve([])', start)
    const block = syncSource.slice(start, end)
    expect(block).toContain(".order('updated_at'")
    expect(block).toContain("query.gt('updated_at', since)")
  })

  it('touches invoices and payments in both supplier merge paths', () => {
    expect(syncSource).toContain('UPDATE supplier_payments SET supplier_id = $1, updated_at = $4')
    expect(supplierSource).toContain("table === 'supply_invoices' || table === 'supplier_payments'")
    expect(supplierSource).toContain('SET supplier_id = $1, updated_at = NOW()')
  })

  it('adds the indexed server timestamp required by delta pull', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()')
    expect(migration).toContain('idx_supplier_payments_tenant_updated')
  })
})