import type { LocalDatabase } from '../db/localDatabase'
import type { LocalSyncOutboxOperation } from '../db/localTypes'
import { attachWriteoffCopyDetails } from './writeoffCopyDetails'
import { attachSupplierInvoiceCopyDetails } from './supplierInvoiceCopyDetails'

/**
 * Enrich missing legacy copy fields from the exact local document, never today's
 * customer balance. Ambiguous historical credit rows remain unacknowledged.
 */
function attachReturnCopyDetails(db: LocalDatabase, operation: LocalSyncOutboxOperation, payload: Record<string, any>): void {
  if (operation.operation_type !== 'return.created') return
  const returned = db.prepare(`
    SELECT sale_id,customer_id,approved_by,created_at,shift_id,refund_method,refund_kopecks
    FROM customer_returns WHERE id=? AND tenant_id=? AND status='completed' AND deleted_at IS NULL
  `).get(operation.aggregate_id, operation.tenant_id) as {
    sale_id: string; customer_id: string | null; approved_by: string | null; created_at: string;
    shift_id: string | null; refund_method: string; refund_kopecks: number;
  } | undefined
  if (!returned || returned.sale_id !== payload.sale_id || returned.refund_kopecks !== payload.refund_kopecks
    || returned.refund_method !== payload.refund_method) return
  payload.approved_by ??= returned.approved_by
  payload.created_at ??= returned.created_at
  const queuedShift = Object.hasOwn(payload, 'shift_id')
  if (!queuedShift) payload.shift_id = returned.shift_id
  // NULL explicitly captured by the producer means no shift. A missing legacy
  // field with no local link remains unknown; do not infer it from the sale.
  payload.shift_link_recorded ??= payload.shift_id != null || (queuedShift && payload.shift_id === null)
  if (returned.refund_method !== 'credit' || payload.deposit_transaction) return
  const rows = db.prepare(`
    SELECT id,balance_after FROM customer_deposit_transactions
    WHERE tenant_id=? AND customer_id=? AND sale_id=? AND amount=? AND created_at=?
      AND method='return_credit' AND deleted_at IS NULL
    LIMIT 2
  `).all(operation.tenant_id, returned.customer_id, returned.sale_id,
    returned.refund_kopecks, returned.created_at) as Array<{ id: string; balance_after: number }>
  if (rows.length === 1) payload.deposit_transaction = rows[0]
}

/** Recover only omitted provenance from the identical stored payroll row.
 * Explicit fields (including null) and the queued financial decision are immutable. */
function attachSalaryCopyDetails(db: LocalDatabase, operation: LocalSyncOutboxOperation, payload: Record<string, any>): void {
  if (operation.operation_type !== 'salary_payment.created') return
  if (payload.id !== undefined && payload.id !== operation.aggregate_id) return
  const stored = db.prepare(`
    SELECT employee_id,amount,type,method,period,work_date,source,note,shift_id,cash_operation_id,created_at,
      commission_source_sale_id,commission_source_order_id,commission_source_return_id,created_by
    FROM salary_payments WHERE id=? AND tenant_id=? AND deleted_at IS NULL
  `).get(operation.aggregate_id, operation.tenant_id) as Record<string, any> | undefined
  if (!stored || stored.employee_id !== payload.employee_id || stored.amount !== payload.amount || stored.source !== payload.source) return
  const decisionFields = ['type', 'method', 'period', 'work_date', 'note', 'shift_id', 'cash_operation_id', 'created_at']
  if (decisionFields.some(field => payload[field] !== undefined && payload[field] !== stored[field])) return
  for (const field of ['commission_source_sale_id', 'commission_source_order_id', 'commission_source_return_id', 'created_by']) {
    if (payload[field] === undefined) payload[field] = stored[field]
  }
}

/** Legacy delete messages carried only an ID. Enrich from the matching local
 * tombstone, not from an active/recreated row, and never mutate the saved queue. */
function attachSalaryDeletionCopy(db: LocalDatabase, operation: LocalSyncOutboxOperation, payload: Record<string, any>): void {
  if (operation.operation_type !== 'salary_payment.deleted' || payload.deleted_payment !== undefined) return
  if (payload.id !== undefined && payload.id !== operation.aggregate_id) return
  const payment = db.prepare(`
    SELECT id,employee_id,employee_name,amount,type,method,period,work_date,source,note,shift_id,cash_operation_id,
             commission_source_sale_id,commission_source_order_id,commission_source_return_id,created_by,created_at
    FROM salary_payments WHERE id=? AND tenant_id=? AND source='manual' AND deleted_at=?
  `).get(operation.aggregate_id, operation.tenant_id, operation.created_at)
  if (payment) payload.deleted_payment = payment
}

/** One SQLite transaction gives all outgoing documents the same current source version. */
export function attachBalanceSnapshots(db: LocalDatabase, operations: LocalSyncOutboxOperation[], sign?: (text: string) => string): LocalSyncOutboxOperation[] {
  const copies = db.readSnapshot(() => {
    // sqlite_sequence survives deletion of delivered/staff outbox rows.
    const version = Number((db.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='sync_outbox'),0) n").get() as { n: number }).n)
    const customersByTenant = new Map<string, unknown[]>()
    return operations.map(operation => {
      const payload = { ...(operation.payload ?? {}) }
      attachReturnCopyDetails(db, operation, payload)
      attachWriteoffCopyDetails(db, operation, payload)
      attachSupplierInvoiceCopyDetails(db, operation, payload)
      attachSalaryCopyDetails(db, operation, payload)
      attachSalaryDeletionCopy(db, operation, payload)
      const ids = new Set<string>()
      if (operation.aggregate_type === 'product') ids.add(operation.aggregate_id)
      if (typeof payload.product_id === 'string') ids.add(payload.product_id)
      for (const item of Array.isArray(payload.items) ? payload.items : []) {
        if (typeof item?.product_id === 'string') ids.add(item.product_id)
      }
      // Cancellation payloads contain just a document ID. Their current stock is
      // still authoritative; resolve references from the local document, never cloud.
      const documentTables: Record<string, [string, string]> = {
        supply_invoice: ['supply_invoice_items', 'invoice_id'],
        customer_order: ['customer_order_items', 'order_id'],
        inventory_session: ['inventory_items', 'session_id'],
      }
      const document = documentTables[operation.aggregate_type]
      if (document) {
        for (const row of db.prepare(`SELECT product_id FROM ${document[0]} WHERE ${document[1]}=? AND tenant_id=?`)
          .all(operation.aggregate_id, operation.tenant_id) as Array<{product_id: string | null}>) {
          if (row.product_id) ids.add(row.product_id)
        }
      }
      if (operation.operation_type === 'customer.deposit_changed' || (operation.operation_type === 'order.payment_added' && payload.method === 'account')) {
        const transaction = db.prepare('SELECT balance_after FROM customer_deposit_transactions WHERE id=? AND tenant_id=?')
          .get(payload.transaction_id ?? payload.account_transaction_id ?? operation.operation_id, operation.tenant_id) as {balance_after:number} | undefined
        if (transaction) payload.balance_after = transaction.balance_after
      }
      const products: unknown[] = []
      const productIds = [...ids]
      for (let start=0; start<productIds.length; start+=400) {
        const part=productIds.slice(start,start+400)
        products.push(...db.prepare(`SELECT id,qty_on_hand FROM products WHERE tenant_id=? AND id IN (${part.map(()=>'?').join(',')})`)
          .all(operation.tenant_id,...part))
      }
      if (!customersByTenant.has(operation.tenant_id)) {
        customersByTenant.set(operation.tenant_id, db.prepare(`SELECT id, COALESCE(debt_balance,0) debt_balance,
          COALESCE(deposit_balance,0) deposit_balance, COALESCE(bonus_balance,0) bonus_balance
          FROM customers WHERE tenant_id=?`).all(operation.tenant_id))
      }
      const snapshot = {
        source_version: version, products, customers: customersByTenant.get(operation.tenant_id),
      }
      return { ...operation, payload: { ...payload, local_balance_snapshot: snapshot } }
    })
  })
  // DPAPI and key-file I/O must not extend the SQLite transaction.
  return copies.map(operation => {
    const snapshot=operation.payload.local_balance_snapshot
    const signature=sign?.(JSON.stringify({tenant_id:operation.tenant_id,device_id:db.deviceId,snapshot}))
    return {...operation,payload:{...operation.payload,local_balance_snapshot:{...snapshot,signature}}}
  })
}
