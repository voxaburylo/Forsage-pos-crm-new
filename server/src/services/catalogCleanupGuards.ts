/** Pure metadata boundary shared by REST edits and offline sync; no DB imports. */
const reserved = ['cleanup_sources', 'cleanup_stock_review', 'cleanup_mirror_receipts', 'cleanup_mirrored_at',
  'cleanup_barcodes', 'merged_into_product_id', 'merge_operation_id'] as const
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function isMergedCatalogSource(specs: unknown): boolean {
  return Boolean(object(specs).merged_into_product_id)
}
/** Cleanup authority cannot be introduced, removed or rewritten by an ordinary edit. */
export function preserveCleanupSpecs(incoming: unknown, existing: unknown): Record<string, unknown> {
  const result = { ...object(incoming) }, current = object(existing)
  for (const key of reserved) {
    delete result[key]
    if (Object.prototype.hasOwnProperty.call(current, key)) result[key] = current[key]
  }
  return result
}
