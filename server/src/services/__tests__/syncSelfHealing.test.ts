import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const syncSource = readFileSync(new URL('../syncService.ts', import.meta.url), 'utf8')
const migration = readFileSync(
  new URL('../../../../supabase/migrations/20260731125328_allow_negative_commission_reversals.sql', import.meta.url),
  'utf8',
)

describe('sync self-healing safeguards', () => {
  it('allows only negative commission reversals and keeps ordinary salary entries positive', () => {
    expect(migration).toContain("source = 'commission_reversal' AND amount < 0")
    expect(migration).toContain("source <> 'commission_reversal' AND amount > 0")
  })

  it('uses bounded canonical snapshots for catalog, orders and recent receipt history', () => {
    expect(syncSource).toContain('const snapshotSince = referencesIncluded ? undefined : since')
    expect(syncSource).toContain("if (referencesIncluded) query = query.gte('completed_at', historySince)")
    expect(syncSource).toContain('activeReferenceQuery')
    expect(syncSource).toContain('references_included: referencesIncluded')
    expect(syncSource).not.toContain('function withChangedSince')
  })

  it('repairs embedded browser reference values and publishes every reference tombstone', () => {
    expect(syncSource).toContain('referenceProductIds')
    expect(syncSource).toContain('result.additional_barcodes =')
    expect(syncSource).toContain('result.aliases =')
    expect(syncSource).toContain('result.cross_numbers =')
    expect(syncSource).toContain('deleted_product_barcode_ids:')
    expect(syncSource).toContain('deleted_product_alias_ids:')
    expect(syncSource).toContain('deleted_product_cross_number_ids:')
    expect(syncSource).toContain('deleted_customer_vehicle_ids:')
    expect(syncSource).toContain('deleted_category_ids:')
    expect(syncSource).toContain('deleted_brand_ids:')
  })
})