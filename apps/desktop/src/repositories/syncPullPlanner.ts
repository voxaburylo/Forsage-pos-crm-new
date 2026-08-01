import type { LocalBootstrapSnapshot, LocalSyncPullChanges } from '../db/localTypes'

export const DEFAULT_PULL_CHUNK_SIZE = 100

type ArrayKey = {
  [K in keyof LocalSyncPullChanges]-?: NonNullable<LocalSyncPullChanges[K]> extends any[] ? K : never
}[keyof LocalSyncPullChanges] & string

function baseChunk(changes: LocalSyncPullChanges): LocalSyncPullChanges {
  return {
    cursor: changes.cursor,
    tenant_id: changes.tenant_id,
    // Snapshot cleanup is deliberately finalized only after every data chunk
    // has committed successfully. A retry can therefore safely replay chunks.
    references_included: false,
    catalog_structure_snapshot_included: false,
    staff_snapshot_included: false,
    commission_rules_snapshot_included: false,
    salary_payments_snapshot_included: false,
    stock_reserves_snapshot_included: false,
  }
}

function slices<T>(rows: T[] | undefined, size: number): T[][] {
  if (!rows?.length) return []
  const result: T[][] = []
  for (let offset = 0; offset < rows.length; offset += size) {
    result.push(rows.slice(offset, offset + size))
  }
  return result
}

function rowId(row: any): string | null {
  const id = row?.id
  return typeof id === 'string' && id ? id : null
}

/**
 * Splits one server response without losing document atomicity. Catalog and
 * independent ledgers are bounded; a document parent and every child supplied
 * for that parent always stay in the same SQLite transaction.
 */
export function createPullChangeChunks(
  changes: LocalSyncPullChanges,
  chunkSize = DEFAULT_PULL_CHUNK_SIZE,
): LocalSyncPullChanges[] {
  const size = Math.max(1, Math.floor(chunkSize))
  const result: LocalSyncPullChanges[] = []
  const make = () => baseChunk(changes)
  const push = (chunk: LocalSyncPullChanges) => result.push(chunk)

  const pushArray = (key: ArrayKey, rows: any[] | undefined) => {
    for (const part of slices(rows, size)) {
      push({ ...make(), [key]: part })
    }
  }

  if (changes.shop_settings) push({ ...make(), shop_settings: changes.shop_settings })

  // Dependencies first. Categories are intentionally kept together so parent
  // links never point at a category that is scheduled for a later chunk.
  pushArray('staff', changes.staff)
  pushArray('staff_pins', changes.staff_pins)
  if (changes.brands?.length) push({ ...make(), brands: changes.brands })
  if (changes.categories?.length) push({ ...make(), categories: changes.categories })
  pushArray('suppliers', changes.suppliers)
  pushArray('products', changes.products)
  pushArray('product_barcodes', changes.product_barcodes)
  pushArray('product_aliases', changes.product_aliases)
  pushArray('product_cross_numbers', changes.product_cross_numbers)
  pushArray('customers', changes.customers)
  pushArray('customer_vehicles', changes.customer_vehicles)
  pushArray('shifts', changes.shifts)

  const pushDocuments = (
    parentsKey: ArrayKey,
    parents: any[] | undefined,
    childSpecs: Array<{ key: ArrayKey; rows: any[] | undefined; parentKey: string }>,
  ) => {
    const parentRows = parents ?? []
    const consumed = childSpecs.map(() => new Set<any>())
    for (const parentPart of slices(parentRows, Math.max(1, Math.min(25, size)))) {
      const parentIds = new Set(parentPart.map(rowId).filter((id): id is string => Boolean(id)))
      const chunk: LocalSyncPullChanges = { ...make(), [parentsKey]: parentPart }
      childSpecs.forEach((spec, index) => {
        const matching = (spec.rows ?? []).filter((row) => {
          if (!parentIds.has(String(row?.[spec.parentKey] ?? ''))) return false
          consumed[index].add(row)
          return true
        })
        if (matching.length) (chunk as any)[spec.key] = matching
      })
      push(chunk)
    }

    // A server may send a child-only delta for an already-known parent. Keep
    // those rows bounded too; they remain idempotent on replay.
    childSpecs.forEach((spec, index) => {
      const orphanRows = (spec.rows ?? []).filter((row) => !consumed[index].has(row))
      pushArray(spec.key, orphanRows)
    })
  }

  pushDocuments('sales', changes.sales, [
    { key: 'sale_items', rows: changes.sale_items, parentKey: 'sale_id' },
  ])
  pushDocuments('customer_orders', changes.customer_orders, [
    { key: 'customer_order_items', rows: changes.customer_order_items, parentKey: 'order_id' },
    { key: 'order_payments', rows: changes.order_payments, parentKey: 'order_id' },
  ])
  pushDocuments('supply_invoices', changes.supply_invoices, [
    { key: 'supply_invoice_items', rows: changes.supply_invoice_items, parentKey: 'invoice_id' },
    { key: 'supplier_payments', rows: changes.supplier_payments, parentKey: 'invoice_id' },
  ])
  pushDocuments('inventory_sessions', changes.inventory_sessions, [
    { key: 'inventory_items', rows: changes.inventory_items, parentKey: 'session_id' },
  ])
  pushDocuments('customer_returns', changes.customer_returns, [
    { key: 'customer_return_items', rows: changes.customer_return_items, parentKey: 'return_id' },
  ])
  pushDocuments('writeoffs', changes.writeoffs, [
    { key: 'writeoff_items', rows: changes.writeoff_items, parentKey: 'writeoff_id' },
  ])

  pushArray('commission_rules', changes.commission_rules)
  pushArray('cash_operations', changes.cash_operations)
  pushArray('stock_reserves', changes.stock_reserves)
  pushArray('warehouse_movements', changes.warehouse_movements)
  pushArray('bonus_transactions', changes.bonus_transactions)
  pushArray('customer_deposit_transactions', changes.customer_deposit_transactions)
  pushArray('salary_payments', changes.salary_payments)
  pushArray('supplier_price_items', changes.supplier_price_items)
  pushArray('supplier_price_imports', changes.supplier_price_imports)

  pushArray('deleted_product_ids', changes.deleted_product_ids)
  pushArray('deleted_customer_ids', changes.deleted_customer_ids)
  pushArray('deleted_supplier_ids', changes.deleted_supplier_ids)
  pushArray('deleted_customer_order_ids', changes.deleted_customer_order_ids)
  pushArray('deleted_supply_invoice_ids', changes.deleted_supply_invoice_ids)
  pushArray('deleted_inventory_session_ids', changes.deleted_inventory_session_ids)
  pushArray('deleted_salary_payment_ids', changes.deleted_salary_payment_ids)
  pushArray('deleted_cash_operation_ids', changes.deleted_cash_operation_ids)

  // Even an empty delta must advance its cursor, but cursor advancement happens
  // in LocalSyncRepository only after this no-op chunk succeeds.
  if (result.length === 0) result.push(make())
  return result
}

export function bootstrapSnapshotToPullChanges(snapshot: LocalBootstrapSnapshot): LocalSyncPullChanges {
  return {
    ...(snapshot as Omit<LocalBootstrapSnapshot, 'exported_at'>),
    cursor: snapshot.exported_at,
    tenant_id: snapshot.tenant_id,
    references_included: true,
    catalog_structure_snapshot_included: true,
    staff_snapshot_included: true,
    commission_rules_snapshot_included: true,
    salary_payments_snapshot_included: true,
    stock_reserves_snapshot_included: true,
  }
}
