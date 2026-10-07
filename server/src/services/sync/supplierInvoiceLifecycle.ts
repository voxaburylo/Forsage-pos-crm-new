import { z } from 'zod'
import { runTransaction } from '../../db/pg.js'
import { AppError } from '../../middleware/errorHandler.js'
import type { SyncOutboxOperation } from './syncCore.js'
import { invoiceId, invoiceDate, invoiceLine, invoiceMoney, invoiceQty, invoiceSnapshot,
  invoiceInvalid, invoiceConflict, checkInvoiceLines, parseInvoiceSnapshot, snapshotHash,
  readInvoiceState, checkInvoiceReferences, lockInvoiceCopy, checkInvoiceReceipt,
  saveInvoiceReceipt } from './supplierInvoiceState.js'

const updateSchema = z.object({
  id: invoiceId, created_at: invoiceDate,
  supplier_id: invoiceId.nullable().optional(), invoice_number: z.string().max(100).nullable().optional(),
  notes: z.string().nullable().optional(), total: invoiceMoney.optional(),
  items: z.array(invoiceLine).min(1).max(5000).optional(),
  previous_invoice: invoiceSnapshot.optional(),
})
const postingSchema = z.object({
  id: invoiceId, created_at: invoiceDate, user_id: invoiceId,
  items: z.array(z.object({ product_id: invoiceId, qty: invoiceQty, purchase_price: invoiceMoney })).min(1).max(5000),
  invoice_snapshot: invoiceSnapshot.optional(),
})
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const iso = (value: any) => value == null ? null : new Date(value).toISOString()

export async function applySupplierInvoiceUpdated(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const date = payload.created_at === undefined ? operation.created_at : payload.created_at
  const parsed = updateSchema.safeParse({ ...payload, id: payload.id ?? operation.aggregate_id, created_at: date,
    items: Array.isArray(payload.items) ? payload.items.map((line: any) =>
      ({ ...line, created_at: line?.created_at === undefined ? date : line.created_at })) : payload.items })
  if (!parsed.success || parsed.data.id !== operation.aggregate_id.toLowerCase()) invoiceInvalid()
  const copy = parsed.data
  if (copy.items) checkInvoiceLines(copy.items, copy.total ?? copy.items.reduce((sum, item) => sum + item.total, 0))
  if (copy.previous_invoice) parseInvoiceSnapshot(copy.previous_invoice)
  await runTransaction(async client => {
    await lockInvoiceCopy(client, tenantId, operation)
    const invoice = (await client.query('SELECT * FROM supply_invoices WHERE id=$1 FOR UPDATE', [copy.id])).rows[0]
    if (await checkInvoiceReceipt(client, tenantId, operation, copy, invoice, !!copy.previous_invoice)) return
    const current = await readInvoiceState(client, tenantId, invoice)
    if (invoice.status !== 'draft') throw new AppError('INVOICE_STATE_CONFLICT', 'Редагувати можна лише чернетку приходу.', 409)
    if (copy.previous_invoice && snapshotHash(copy.previous_invoice) !== snapshotHash(current)) invoiceConflict()
    const next = parseInvoiceSnapshot({
      ...current,
      supplier_id: own(copy, 'supplier_id') ? copy.supplier_id : current.supplier_id,
      invoice_number: own(copy, 'invoice_number') ? copy.invoice_number : current.invoice_number,
      notes: own(copy, 'notes') ? copy.notes : current.notes,
      items: copy.items ?? current.items,
      total: copy.items ? copy.items.reduce((sum, line) => sum + line.total, 0) : current.total,
    })
    if ((copy.total !== undefined && copy.total !== next.total) || next.total < Number(invoice.paid_amount)
      || (Number(invoice.paid_amount) > 0 && next.supplier_id !== current.supplier_id)) invoiceConflict()
    await checkInvoiceReferences(client, tenantId, next)
    if (copy.items) {
      const collision = await client.query('SELECT id FROM supply_invoice_items WHERE id=ANY($1::uuid[]) AND (invoice_id<>$2 OR tenant_id<>$3)',
        [copy.items.map(line => line.id), copy.id, tenantId])
      if (collision.rowCount) invoiceConflict()
      await client.query('DELETE FROM supply_invoice_items WHERE invoice_id=$1 AND tenant_id=$2', [copy.id, tenantId])
      for (const item of copy.items) await client.query(
        'INSERT INTO supply_invoice_items(id,tenant_id,invoice_id,product_id,qty,purchase_price,total,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [item.id, tenantId, copy.id, item.product_id, item.qty, item.purchase_price, item.total, item.created_at])
    }
    await client.query(`UPDATE supply_invoices SET supplier_id=$3,invoice_number=$4,notes=$5,total=$6,
      draft_payload=NULL,draft_saved_at=NULL,draft_saved_by=NULL,updated_at=$7 WHERE id=$1 AND tenant_id=$2`,
      [copy.id, tenantId, next.supplier_id, next.invoice_number, next.notes, next.total, operation.applied_at ?? operation.created_at])
    await saveInvoiceReceipt(client, tenantId, operation, copy)
  })
}

/** Local posting already changed stock. This endpoint only mirrors its document,
 * even when a legacy request lacks the current balance_mirrored transport flag. */
export async function applySupplierInvoicePosted(tenantId: string, _uploader: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const parsed = postingSchema.safeParse({ ...payload, id: payload.id ?? operation.aggregate_id,
    created_at: payload.created_at === undefined ? operation.created_at : payload.created_at })
  if (!parsed.success || parsed.data.id !== operation.aggregate_id.toLowerCase()) invoiceInvalid()
  const copy = parsed.data
  if (copy.invoice_snapshot) parseInvoiceSnapshot(copy.invoice_snapshot)
  const lineSet = (items: { product_id: string; qty: number; purchase_price: number }[]) =>
    items.map(item => JSON.stringify([item.product_id, item.qty, item.purchase_price])).sort()
  await runTransaction(async client => {
    await lockInvoiceCopy(client, tenantId, operation)
    const invoice = (await client.query('SELECT * FROM supply_invoices WHERE id=$1 FOR UPDATE', [copy.id])).rows[0]
    const acknowledged = await checkInvoiceReceipt(client, tenantId, operation, copy, invoice, !!copy.invoice_snapshot)
    const current = await readInvoiceState(client, tenantId, invoice)
    if (JSON.stringify(lineSet(copy.items)) !== JSON.stringify(lineSet(current.items))
      || (!acknowledged && copy.invoice_snapshot && snapshotHash(copy.invoice_snapshot) !== snapshotHash(current))) invoiceConflict()
    await checkInvoiceReferences(client, tenantId, current)
    const actor = await client.query("SELECT id FROM auth.users WHERE id=$1 AND raw_app_meta_data->>'tenant_id'=$2", [copy.user_id, tenantId])
    if (!actor.rowCount) throw new AppError('SYNC_INVOICE_COPY_REQUIRED', 'Спочатку потрібна копія працівника, який провів прихід.', 409)
    if (acknowledged || invoice.status === 'posted') {
      if ((invoice.status !== 'posted' && !(acknowledged && invoice.status === 'cancelled'))
        || invoice.deleted_at || invoice.posted_by !== copy.user_id || iso(invoice.posted_at) !== copy.created_at) invoiceConflict()
    } else {
      if (invoice.status !== 'draft') throw new AppError('INVOICE_STATE_CONFLICT', 'Стан копії приходу не відповідає проведенню.', 409)
      await client.query("UPDATE supply_invoices SET status='posted',posted_by=$3,posted_at=$4,updated_at=$5 WHERE id=$1 AND tenant_id=$2",
        [copy.id, tenantId, copy.user_id, copy.created_at, operation.applied_at ?? operation.created_at])
    }
    if (!acknowledged) await saveInvoiceReceipt(client, tenantId, operation, copy)
  })
}
