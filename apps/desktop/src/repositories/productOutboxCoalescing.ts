export type ProductOutboxVersion = {
  sequence: number
  aggregate_id: string
  operation_type: 'product.upsert' | 'product.deleted'
  payload_json: string
}

// Caller selects pending/failed product versions, ordered by aggregate_id,
// sequence DESC. Retain the newest version and the latest explicit correction
// when the newest version is an upsert; do not change stock or payloads here.
export function supersededProductSequences(rows: readonly ProductOutboxVersion[]): number[] {
  const superseded: number[] = []
  let currentId: string | undefined
  let seekingCorrection = false
  for (const row of rows) {
    if (row.aggregate_id !== currentId) {
      currentId = row.aggregate_id
      seekingCorrection = row.operation_type === 'product.upsert' && !isStockCorrection(row)
      continue // The first row in each ordered group is always retained.
    }
    if (seekingCorrection && isStockCorrection(row)) {
      seekingCorrection = false
      continue
    }
    superseded.push(row.sequence)
  }
  return superseded
}

function isStockCorrection(row: ProductOutboxVersion): boolean {
  if (row.operation_type !== 'product.upsert') return false
  try { return JSON.parse(row.payload_json)?.stock_correction === true } catch { return false }
}
