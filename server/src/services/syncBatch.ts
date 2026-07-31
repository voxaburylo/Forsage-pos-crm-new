export interface SyncBatchOperation {
  sequence: number
  operation_id: string
  tenant_id: string
  aggregate_type: string
  aggregate_id: string
  operation_type: string
  payload: any
}

export interface SyncBatchResult {
  sequence: number
  operation_id: string
  aggregate_id?: string
  status: 'synced' | 'failed'
  error?: string
}

function dependencyKeys(operation: SyncBatchOperation): string[] {
  const prefix = operation.tenant_id
  const payload = operation.payload ?? {}
  const keys = new Set<string>([
    `${prefix}:aggregate:${operation.aggregate_type}:${operation.aggregate_id}`,
  ])
  const addReference = (type: 'supplier' | 'product' | 'invoice', value: unknown) => {
    if (typeof value === 'string' && value) keys.add(`${prefix}:reference:${type}:${value}`)
  }

  if (operation.aggregate_type === 'supplier') addReference('supplier', operation.aggregate_id)
  if (operation.aggregate_type === 'product') addReference('product', operation.aggregate_id)
  if (operation.aggregate_type === 'supply_invoice') addReference('invoice', operation.aggregate_id)

  addReference('supplier', payload.supplier_id)
  addReference('supplier', payload.primary_supplier_id)
  addReference('supplier', payload.duplicate_supplier_id)
  addReference('supplier', payload.import?.supplier_id)
  addReference('product', payload.product_id)
  addReference('invoice', payload.invoice_id)
  for (const item of Array.isArray(payload.items) ? payload.items : []) {
    addReference('product', item?.product_id)
  }
  return [...keys]
}

/**
 * Applies independent outbox operations even if one operation fails.
 * Later operations that depend on the failed aggregate/reference stay pending:
 * they are intentionally omitted from the result and will be retried after the
 * dependency succeeds.
 */
export async function processSyncBatch<T extends SyncBatchOperation>(
  operations: T[],
  apply: (operation: T) => Promise<void>,
): Promise<SyncBatchResult[]> {
  const results: SyncBatchResult[] = []
  const blockedKeys = new Set<string>()

  for (const operation of operations) {
    const keys = dependencyKeys(operation)
    if (keys.some((key) => blockedKeys.has(key))) continue

    try {
      await apply(operation)
      results.push({
        sequence: operation.sequence,
        operation_id: operation.operation_id,
        aggregate_id: operation.aggregate_id,
        status: 'synced',
      })
    } catch (error: any) {
      for (const key of keys) blockedKeys.add(key)
      results.push({
        sequence: operation.sequence,
        operation_id: operation.operation_id,
        aggregate_id: operation.aggregate_id,
        status: 'failed',
        error: error?.message ?? 'Помилка синхронізації',
      })
    }
  }

  return results
}
