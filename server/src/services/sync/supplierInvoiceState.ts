import { createHash } from 'node:crypto'
import { assertSupplierNotMerged } from '../supplierMergeSafety.js'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { AppError } from '../../middleware/errorHandler.js'
import { isUuid, type SyncOutboxOperation } from './syncCore.js'

export const invoiceId = z.string().refine(isUuid).transform(value => value.toLowerCase())
export const invoiceDate = z.string().refine(value => Number.isFinite(Date.parse(value)))
  .transform(value => new Date(value).toISOString())
export const invoiceMoney = z.number().int().nonnegative().max(2147483647)
export const invoiceQty = z.number().positive().finite().max(999999999.999)
  .refine(value => Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001)
export const invoiceLine = z.object({ id: invoiceId, product_id: invoiceId, qty: invoiceQty,
  purchase_price: invoiceMoney, total: invoiceMoney, created_at: invoiceDate })
export const invoiceSnapshot = z.object({
  supplier_id: invoiceId.nullable(), invoice_number: z.string().max(100).nullable(),
  notes: z.string().nullable(), total: invoiceMoney, created_at: invoiceDate,
  items: z.array(invoiceLine).min(1).max(5000),
})
export type InvoiceSnapshot = z.infer<typeof invoiceSnapshot>
export function invoiceInvalid(): never {
  throw new AppError('SYNC_INVOICE_COPY_INVALID', 'Для копії приходу потрібні точні рядки, кількість, закупівля та первісні реквізити. Оновіть програму й повторіть передачу.', 422)
}
export function invoiceConflict(): never {
  throw new AppError('SYNC_INVOICE_COPY_CONFLICT', 'Копія приходу відрізняється від підтвердженого документа. Потрібна звірка; рядки, гроші та залишки не перезаписано.', 409)
}
export function checkInvoiceLines(items: z.infer<typeof invoiceLine>[], total: number) {
  const sum = items.reduce((value, item) => value + item.total, 0)
  if (!Number.isSafeInteger(sum) || sum > 2147483647 || sum !== total
    || new Set(items.map(item => item.id)).size !== items.length
    || items.some(item => Math.round(item.qty * item.purchase_price) !== item.total)) invoiceInvalid()
}
const iso = (value: any) => value == null ? null : new Date(value).toISOString()
export function parseInvoiceSnapshot(value: unknown): InvoiceSnapshot {
  const parsed = invoiceSnapshot.safeParse(value)
  if (!parsed.success) invoiceInvalid()
  checkInvoiceLines(parsed.data.items, parsed.data.total)
  return parsed.data
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]))
  return value
}
export const invoiceHash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
export const snapshotHash = (snapshot: InvoiceSnapshot) => invoiceHash({
  ...snapshot, items: [...snapshot.items].sort((a, b) => a.id.localeCompare(b.id)),
})
export const invoiceLifecycleHash = (invoice: any) => invoiceHash({
  status: invoice.status, deleted_at: iso(invoice.deleted_at),
  posted_by: invoice.posted_by ?? null, posted_at: iso(invoice.posted_at),
})
export async function readInvoiceState(client: PoolClient, tenantId: string, invoice: any, allowDeleted = false): Promise<InvoiceSnapshot> {
  if (!invoice || invoice.tenant_id !== tenantId || (invoice.deleted_at && !allowDeleted)
    || !['draft', 'posted', 'cancelled'].includes(invoice.status)) invoiceConflict()
  const lines = (await client.query('SELECT * FROM supply_invoice_items WHERE invoice_id=$1 ORDER BY id', [invoice.id])).rows
  if (lines.some(item => item.tenant_id !== tenantId || item.deleted_at)) invoiceConflict()
  let snapshot: InvoiceSnapshot
  try {
    snapshot = parseInvoiceSnapshot({ supplier_id: invoice.supplier_id, invoice_number: invoice.invoice_number,
      notes: invoice.notes, total: invoice.total, created_at: iso(invoice.created_at),
      items: lines.map(item => ({ id: item.id, product_id: item.product_id, qty: Number(item.qty),
        purchase_price: item.purchase_price, total: item.total, created_at: iso(item.created_at) })) })
  } catch { invoiceConflict() }
  const payments = (await client.query('SELECT * FROM supplier_payments WHERE invoice_id=$1', [invoice.id])).rows
  const paid = payments.reduce((sum, payment) => sum + Number(payment.amount), 0)
  if (payments.some(p => p.tenant_id !== tenantId || p.deleted_at || p.supplier_id !== invoice.supplier_id
    || !Number.isSafeInteger(Number(p.amount)) || Number(p.amount) <= 0)
    || !Number.isSafeInteger(invoice.paid_amount) || !Number.isSafeInteger(paid) || paid !== invoice.paid_amount || paid > snapshot.total
    || (paid === 0 ? invoice.payment_method !== null : !['cash', 'card', 'transfer'].includes(invoice.payment_method))
    || (invoice.status === 'cancelled' && paid > 0)) invoiceConflict()
  return snapshot
}
export async function checkInvoiceReferences(client: PoolClient, tenantId: string, snapshot: InvoiceSnapshot) {

  const ids = [...new Set(snapshot.items.map(item => item.product_id))]
  const products = await client.query('SELECT id FROM products WHERE tenant_id=$1 AND id=ANY($2::uuid[]) FOR KEY SHARE', [tenantId, ids])
  if (products.rowCount !== ids.length) throw new AppError('SYNC_PRODUCT_NOT_FOUND', 'Спочатку передайте всі товари накладної.', 409)
  if (snapshot.supplier_id && !(await client.query('SELECT id FROM suppliers WHERE id=$1 AND tenant_id=$2 FOR KEY SHARE', [snapshot.supplier_id, tenantId])).rowCount)
    throw new AppError('SYNC_SUPPLIER_NOT_FOUND', 'Спочатку передайте постачальника накладної.', 409)
  if (snapshot.supplier_id) await assertSupplierNotMerged(client, tenantId, snapshot.supplier_id)
}
export async function lockInvoiceCopy(client: PoolClient, tenantId: string, operation: SyncOutboxOperation) {
  if (operation.tenant_id !== tenantId || !isUuid(operation.operation_id) || !isUuid(operation.aggregate_id)
    || typeof operation.device_id !== 'string' || !operation.device_id.trim()
    || !Number.isSafeInteger(operation.sequence) || operation.sequence <= 0) invoiceInvalid()
  await client.query("SELECT set_config('app.sync_mode','true',true)")
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['supplier-invoice-copy:' + operation.aggregate_id.toLowerCase()])
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['supplier-invoice-operation:' + tenantId + ':' + operation.operation_id.toLowerCase()])
}
/** The caller holds the invoice lock for the entire mutation+receipt transaction.
 * Never acknowledge only by ID: verify payload and the newest stored content. */
export async function checkInvoiceReceipt(client: PoolClient, tenantId: string, operation: SyncOutboxOperation, payload: unknown, invoice: any, hasSnapshot = false) {
  const receipt = (await client.query('SELECT * FROM supplier_invoice_copy_receipts WHERE tenant_id=$1 AND operation_id=$2',
    [tenantId, operation.operation_id])).rows[0]
  const latest = (await client.query('SELECT document_hash,lifecycle_hash,operation_type,device_id,source_sequence FROM supplier_invoice_copy_receipts WHERE tenant_id=$1 AND invoice_id=$2 ORDER BY receipt_no DESC LIMIT 1',
    [tenantId, operation.aggregate_id])).rows[0]
  if (receipt && (receipt.invoice_id !== operation.aggregate_id.toLowerCase()
    || receipt.operation_type !== operation.operation_type || receipt.payload_hash !== invoiceHash(payload)
    || receipt.device_id !== operation.device_id || Number(receipt.source_sequence) !== operation.sequence)) invoiceConflict()
  if (!receipt && latest && ((latest.device_id === operation.device_id && operation.sequence <= Number(latest.source_sequence))
    || (latest.device_id !== operation.device_id && !hasSnapshot))) invoiceConflict()
  if (latest) {
    if (!invoice || (latest.lifecycle_hash && invoiceLifecycleHash(invoice) !== latest.lifecycle_hash)) invoiceConflict()
    const deleted = latest.operation_type === 'supplier_invoice.deleted'
      || (!!invoice.deleted_at && latest.operation_type === 'supplier_invoice.supplier_merged')
    if ((deleted || latest.operation_type === 'supplier_invoice.cancelled') && !latest.lifecycle_hash) invoiceConflict()
    if (deleted && (invoice.status !== 'draft' || !invoice.deleted_at || invoice.paid_amount !== 0)) invoiceConflict()
    const snapshot = await readInvoiceState(client, tenantId, invoice, deleted)
    if (snapshotHash(snapshot) !== latest.document_hash) invoiceConflict()
  } else if (receipt || invoice?.deleted_at) invoiceConflict()
  return !!receipt
}
export async function saveInvoiceReceipt(client: PoolClient, tenantId: string, operation: SyncOutboxOperation, payload: unknown) {
  const invoice = (await client.query('SELECT * FROM supply_invoices WHERE id=$1 FOR UPDATE', [operation.aggregate_id])).rows[0]
  const deleted = operation.operation_type === 'supplier_invoice.deleted'
    || (operation.operation_type === 'supplier_invoice.supplier_merged' && !!invoice?.deleted_at)
  if (deleted && (invoice?.status !== 'draft' || !invoice.deleted_at || invoice.paid_amount !== 0)) invoiceConflict()
  const snapshot = await readInvoiceState(client, tenantId, invoice, deleted)
  const saved = await client.query(`INSERT INTO supplier_invoice_copy_receipts(tenant_id,operation_id,invoice_id,operation_type,payload_hash,document_hash,device_id,source_sequence,lifecycle_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING operation_id`, [tenantId, operation.operation_id, operation.aggregate_id,
    operation.operation_type, invoiceHash(payload), snapshotHash(snapshot), operation.device_id, operation.sequence, invoiceLifecycleHash(invoice)])
  if (saved.rowCount !== 1 || !await checkInvoiceReceipt(client, tenantId, operation, payload, invoice, true)) invoiceConflict()
}
