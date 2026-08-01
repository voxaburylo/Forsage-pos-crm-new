import type { LocalSyncPullChanges } from '../db/localTypes'

export interface NormalizedReferenceDeletes {
  productBarcodeIds: string[]
  productAliasIds: string[]
  productCrossNumberIds: string[]
  customerVehicleIds: string[]
  categoryIds: string[]
  brandIds: string[]
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))]
}

function firstArray(source: Record<string, unknown>, names: string[]): string[] {
  for (const name of names) {
    if (Array.isArray(source[name])) return strings(source[name])
  }
  return []
}

/**
 * Adapter boundary for the future ordinary reference-delta contract. The
 * canonical names are typed locally; aliases keep desktop compatible while the
 * server endpoint is rolled out independently.
 */
export function normalizeReferenceDeletes(changes: LocalSyncPullChanges): NormalizedReferenceDeletes {
  const source = changes as unknown as Record<string, unknown>
  return {
    productBarcodeIds: firstArray(source, [
      'deleted_product_barcode_ids',
      'product_barcode_deleted_ids',
    ]),
    productAliasIds: firstArray(source, [
      'deleted_product_alias_ids',
      'product_alias_deleted_ids',
    ]),
    productCrossNumberIds: firstArray(source, [
      'deleted_product_cross_number_ids',
      'product_cross_number_deleted_ids',
    ]),
    customerVehicleIds: firstArray(source, [
      'deleted_customer_vehicle_ids',
      'customer_vehicle_deleted_ids',
    ]),
    categoryIds: firstArray(source, ['deleted_category_ids', 'category_deleted_ids']),
    brandIds: firstArray(source, ['deleted_brand_ids', 'brand_deleted_ids']),
  }
}
