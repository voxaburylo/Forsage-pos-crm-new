import { z } from 'zod'
import { runTransaction } from '../../db/pg.js'
import { AppError } from '../../middleware/errorHandler.js'
import type { SyncOutboxOperation } from './syncCore.js'
import { invoiceId, invoiceDate, invoiceSnapshot, parseInvoiceSnapshot, snapshotHash,
  invoiceInvalid, invoiceConflict, lockInvoiceCopy, checkInvoiceReceipt, readInvoiceState,
  saveInvoiceReceipt } from './supplierInvoiceState.js'

const schema = z.object({
  id: invoiceId, created_at: invoiceDate, previous_invoice: invoiceSnapshot.optional(),
  previous_status: z.enum(['draft', 'posted']).optional(),
  posted_by: invoiceId.nullable().optional(), posted_at: invoiceDate.nullable().optional(),
})
const iso = (value: any) => value == null ? null : new Date(value).toISOString()

/** Local cancellation has already reversed stock. Only copy the terminal state,
 * in the same transaction as its durable acknowledgement. Keep the rows for audit. */
async function finishCopy(tenantId: string, operation: SyncOutboxOperation, kind: 'cancelled' | 'deleted'): Promise<void> {
  const payload = operation.payload ?? {}
  const parsed = schema.safeParse({ ...payload, id: payload.id ?? operation.aggregate_id,
    created_at: payload.created_at === undefined ? operation.created_at : payload.created_at })
  if (!parsed.success || typeof operation.aggregate_id !== 'string' || parsed.data.id !== operation.aggregate_id.toLowerCase()
    || operation.operation_type !== 'supplier_invoice.' + kind) invoiceInvalid()
  const copy = parsed.data
  const full = copy.previous_invoice !== undefined
  if (full !== (copy.previous_status !== undefined) || full !== (copy.posted_by !== undefined)
    || full !== (copy.posted_at !== undefined)) invoiceInvalid()
  if (full) parseInvoiceSnapshot(copy.previous_invoice)
  await runTransaction(async client => {
    await lockInvoiceCopy(client, tenantId, operation)
    const invoice = (await client.query('SELECT * FROM supply_invoices WHERE id=$1 FOR UPDATE', [copy.id])).rows[0]
    if (await checkInvoiceReceipt(client, tenantId, operation, copy, invoice, full)) return
    const current = await readInvoiceState(client, tenantId, invoice)
    if (invoice.status === 'cancelled') invoiceConflict()
    if (invoice.paid_amount !== 0) throw new AppError('PAID_INVOICE_CANNOT_BE_CANCELLED', 'Не можна скасувати або видалити оплачену накладну.', 409)
    if (kind === 'deleted' && invoice.status !== 'draft')
      throw new AppError('INVOICE_DELETE_FORBIDDEN', 'Видалити можна лише неоплачену чернетку накладної.', 409)
    if (full && (snapshotHash(copy.previous_invoice!) !== snapshotHash(current) || copy.previous_status !== invoice.status
      || copy.posted_by !== (invoice.posted_by ?? null) || copy.posted_at !== iso(invoice.posted_at))) invoiceConflict()
    if (kind === 'cancelled') await client.query(
      "UPDATE supply_invoices SET status='cancelled',updated_at=$3 WHERE id=$1 AND tenant_id=$2",
      [copy.id, tenantId, operation.applied_at ?? operation.created_at])
    else await client.query(
      'UPDATE supply_invoices SET deleted_at=$3,updated_at=$4 WHERE id=$1 AND tenant_id=$2',
      [copy.id, tenantId, copy.created_at, operation.applied_at ?? operation.created_at])
    await saveInvoiceReceipt(client, tenantId, operation, copy)
  })
}

export async function applySupplierInvoiceCancelled(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  await finishCopy(tenantId, operation, 'cancelled')
}
export async function applySupplierInvoiceDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  await finishCopy(tenantId, operation, 'deleted')
}
