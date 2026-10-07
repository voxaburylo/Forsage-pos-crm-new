import type { LocalDatabase } from '../db/localDatabase'
import type { LocalSyncOutboxOperation } from '../db/localTypes'

/** Old creation messages omitted the payer. Recover only from their exact
 * immutable payment; the currently signed-in sender is not the original payer. */
export function attachSupplierInvoiceCopyDetails(db: LocalDatabase, operation: LocalSyncOutboxOperation, payload: Record<string, any>): void {
  if (operation.operation_type === 'supplier_invoice.payment_added') {
    attachPaymentDetails(db, operation, payload)
    return
  }
  if (operation.operation_type !== 'supplier_invoice.created' || payload.user_id !== undefined
    || (payload.id !== undefined && payload.id !== operation.aggregate_id)
    || typeof payload.paid_amount !== 'number' || payload.paid_amount <= 0 || typeof payload.payment_id !== 'string') return
  const payment = db.prepare(`SELECT invoice_id,supplier_id,amount,payment_method,fund_source,shift_id,note,created_by,created_at
    FROM supplier_payments WHERE id=? AND tenant_id=? AND deleted_at IS NULL`)
    .get(payload.payment_id, operation.tenant_id) as Record<string, any> | undefined
  if (!payment || payment.invoice_id !== operation.aggregate_id || payment.amount !== payload.paid_amount
    || payment.supplier_id !== (payload.supplier_id ?? null) || payment.payment_method !== payload.payment_method
    || payment.fund_source !== payload.fund_source || payment.shift_id !== (payload.shift_id ?? null)
    || payment.note !== 'Оплата під час створення накладної'
    || payment.created_at !== (payload.created_at ?? operation.created_at)) return
  payload.user_id = payment.created_by
}

/** Fill omissions in old payment messages from the payment itself, never from
 * today's invoice/supplier or session. Do not rewrite persisted queue entries. */
function attachPaymentDetails(db: LocalDatabase, operation: LocalSyncOutboxOperation, payload: Record<string, any>): void {
  if ((payload.id !== undefined && payload.id !== operation.aggregate_id)
    || typeof payload.payment_id !== 'string' || typeof payload.amount !== 'number' || payload.amount <= 0) return
  const payment = db.prepare(`SELECT invoice_id,supplier_id,amount,payment_method,fund_source,shift_id,note,created_by,created_at
    FROM supplier_payments WHERE id=? AND tenant_id=? AND deleted_at IS NULL`)
    .get(payload.payment_id, operation.tenant_id) as Record<string, any> | undefined
  if (!payment || payment.invoice_id !== operation.aggregate_id || payment.amount !== payload.amount
    || payment.payment_method !== payload.payment_method || payment.fund_source !== payload.fund_source
    || payment.shift_id !== (payload.shift_id ?? null) || payment.note !== (payload.note ?? null)
    || payment.created_at !== (payload.created_at ?? operation.created_at)
    || (payload.supplier_id !== undefined && payment.supplier_id !== payload.supplier_id)
    || (payload.user_id !== undefined && payment.created_by !== payload.user_id)) return
  if (payload.supplier_id === undefined) payload.supplier_id = payment.supplier_id
  if (payload.user_id === undefined) payload.user_id = payment.created_by
  if (payload.created_at === undefined) payload.created_at = payment.created_at
}
