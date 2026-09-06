type CountState = { expected_stock: number; counted_stock: number; price_checked: boolean; observed_retail_price: number | null; product: { retail_price: number } | null }
type ScanSummary = { counted_products: number; matching_products: number; discrepancy_products: number; price_checked_products: number; price_mismatch_products: number; total_expected_units: number; total_counted_units: number }

function contribution(item: CountState | undefined): ScanSummary {
  if (!item) return { counted_products: 0, matching_products: 0, discrepancy_products: 0, price_checked_products: 0, price_mismatch_products: 0, total_expected_units: 0, total_counted_units: 0 }
  return {
    counted_products: 1,
    matching_products: Number(item.counted_stock === item.expected_stock),
    discrepancy_products: Number(item.counted_stock !== item.expected_stock),
    price_checked_products: Number(item.price_checked),
    price_mismatch_products: Number(item.product !== null && item.observed_retail_price !== null && item.observed_retail_price !== item.product.retail_price),
    total_expected_units: item.expected_stock,
    total_counted_units: item.counted_stock,
  }
}

export function updateScanSummary<T extends ScanSummary>(summary: T, previous: CountState | undefined, next: CountState): T {
  const before = contribution(previous)
  const after = contribution(next)
  const result = { ...summary }
  for (const key of Object.keys(after) as Array<keyof ScanSummary>) {
    result[key] = summary[key] + after[key] - before[key]
  }
  return result
}

export function inventoryHasPendingWrites(rowWrites: number, scanRunning: boolean, queuedScans: number): boolean {
  return rowWrites > 0 || scanRunning || queuedScans > 0
}

export class InventoryReadGuard {
  private revision = 0
  begin(): number { return ++this.revision }
  invalidate(): void { this.revision++ }
  isCurrent(token: number): boolean { return token === this.revision }
}
