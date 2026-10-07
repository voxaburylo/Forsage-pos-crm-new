import { syncModuleSource as syncSource } from './helpers/syncSource.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const supplierSource = readFileSync(new URL('../supplierService.ts', import.meta.url), 'utf8')
const keysetSource = readFileSync(new URL('../syncKeyset.ts', import.meta.url), 'utf8')
const migration = readFileSync(
  new URL('../../../../supabase/migrations/20260729120000_supplier_payment_sync_timestamp.sql', import.meta.url),
  'utf8',
)

describe('supplier reference synchronization safety', () => {
  it('pulls changed historical supplier payments by updated_at', () => {
    const start = syncSource.indexOf(".from('supplier_payments')")
    const end = syncSource.indexOf(': Promise.resolve([])', start)
    const block = syncSource.slice(start, end)
    expect(block).toContain('referencesIncluded ? undefined : since')
    expect(keysetSource).toContain('if (options.lowerBound) query = query.gt(options.timestampColumn, options.lowerBound)')
    expect(keysetSource).toContain('.order(options.timestampColumn, { ascending: true })')
  })

  it('routes both merge paths through the history guard instead of rewriting financial identities', () => {
    expect(syncSource).toContain('await mergeEmptySupplier(primaryId, duplicateId, tenantId, operation.created_at)')
    expect(supplierSource).toContain('return mergeEmptySupplier(primaryId, duplicateId, tenantId)')
    expect(supplierSource).not.toContain('SET supplier_id = $1 WHERE supplier_id = $2')
  })

  it('adds the indexed server timestamp required by delta pull', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()')
    expect(migration).toContain('idx_supplier_payments_tenant_updated')
  })
})
