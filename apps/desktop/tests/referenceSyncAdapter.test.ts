import { describe, expect, it } from 'vitest'
import { normalizeReferenceDeletes } from '../src/repositories/referenceSyncAdapter'

describe('reference delta adapter', () => {
  it('normalizes canonical tombstones and rollout aliases without duplicates', () => {
    expect(normalizeReferenceDeletes({
      cursor: '2026-08-01T12:00:00.000Z',
      deleted_product_barcode_ids: ['barcode-1', 'barcode-1'],
      product_alias_deleted_ids: ['alias-1'],
      deleted_customer_vehicle_ids: ['vehicle-1'],
    } as any)).toMatchObject({
      productBarcodeIds: ['barcode-1'],
      productAliasIds: ['alias-1'],
      customerVehicleIds: ['vehicle-1'],
    })
  })
})
