import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { mergedPaymentSupplierMatches } from './supplierHistoryMerge.js'
import { runTransaction } from '../../db/pg.js'
import type { SyncOutboxOperation } from './syncCore.js'
import { financialCopyDeleted, lockFinancialCopy } from './financialCopyGuards.js'
import {
  invoiceId, invoiceDate, invoiceMoney, invoiceInvalid, invoiceConflict,
  lockInvoiceCopy, readInvoiceState, snapshotHash, invoiceLifecycleHash,
} from './supplierInvoiceState.js'

const paymentCopy = z.object({
  id: invoiceId, payment_id: invoiceId, supplier_id: invoiceId.nullable(),
  amount: invoiceMoney.refine(value => value > 0),
  payment_method: z.enum(['cash', 'card', 'transfer']),
  fund_source: z.enum(['cashbox', 'owner_funds', 'bank_account', 'business_card']),
  shift_id: invoiceId.nullable().default(null), note: z.string().nullable().default(null),
  user_id: invoiceId, created_at: invoiceDate,
})
const iso = (value: any) => value == null ? null : new Date(value).toISOString()

type PaymentCopy = z.infer<typeof paymentCopy>
async function assertPaymentStored(client: PoolClient, tenant: string, copy: PaymentCopy, payment: any, cash: any, allowMerged: boolean) {
  if (!payment || payment.id !== copy.payment_id || payment.tenant_id !== tenant || payment.invoice_id !== copy.id
    || (allowMerged
      ? !await mergedPaymentSupplierMatches(client,tenant,copy.id,copy.payment_id,copy.supplier_id,payment.supplier_id)
      : payment.supplier_id !== copy.supplier_id)
    || payment.amount !== copy.amount || payment.payment_method !== copy.payment_method
    || payment.fund_source !== copy.fund_source || payment.shift_id !== copy.shift_id
    || payment.note !== copy.note || payment.created_by !== copy.user_id
    || iso(payment.created_at) !== copy.created_at || payment.deleted_at) invoiceConflict()
  if (copy.fund_source === 'cashbox') {
    if (!cash || cash.id !== copy.payment_id || cash.tenant_id !== tenant || cash.shift_id !== copy.shift_id
      || cash.type !== 'out' || cash.source !== 'cashbox' || cash.amount !== copy.amount
      || cash.note !== (copy.note ?? 'Оплата постачальнику') || cash.created_by !== copy.user_id
      || iso(cash.created_at) !== copy.created_at || cash.deleted_at || cash.sale_id || cash.employee_id || cash.work_date) invoiceConflict()
  } else if (cash) invoiceConflict()
}
const validWriteDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime())

/** Mirror an already completed local payment, not a new withdrawal.
 * Payment ID is the immutable retry key; never use the uploading user as payer.
 * The invoice, payment and cash locks are acquired in creation's order. */
export async function applySupplierInvoicePaymentAdded(tenantId: string, _userId: string, operation: SyncOutboxOperation): Promise<void> {
  const parsed = paymentCopy.safeParse({ ...operation.payload,
    id: operation.payload?.id ?? operation.aggregate_id,
    created_at: operation.payload?.created_at ?? operation.created_at })
  if (!parsed.success || operation.operation_type !== 'supplier_invoice.payment_added') invoiceInvalid()
  const copy = parsed.data
  if (typeof operation.aggregate_id !== 'string' || copy.id !== operation.aggregate_id.toLowerCase()
    || (copy.fund_source === 'cashbox' && (copy.payment_method !== 'cash' || !copy.shift_id))) invoiceInvalid()
  await runTransaction(async client => {
    await lockInvoiceCopy(client, tenantId, operation)
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['supplier-payment-copy:' + copy.payment_id])
    await lockFinancialCopy(client, 'cash_operation', copy.payment_id)
    const invoice = (await client.query('SELECT * FROM supply_invoices WHERE id=$1 FOR UPDATE', [copy.id])).rows[0]
    const snapshot = await readInvoiceState(client, tenantId, invoice)
    if (invoice.status === 'cancelled') invoiceConflict()
    const latest = (await client.query('SELECT document_hash,lifecycle_hash FROM supplier_invoice_copy_receipts WHERE tenant_id=$1 AND invoice_id=$2 ORDER BY receipt_no DESC LIMIT 1',
      [tenantId, copy.id])).rows[0]
    if (latest && (snapshotHash(snapshot) !== latest.document_hash
      || (latest.lifecycle_hash && invoiceLifecycleHash(invoice) !== latest.lifecycle_hash))) invoiceConflict()
    // A document-operation ID must not be reused as a payment operation.
    if ((await client.query('SELECT 1 FROM supplier_invoice_copy_receipts WHERE tenant_id=$1 AND operation_id=$2',
      [tenantId, operation.operation_id])).rowCount) invoiceConflict()
    if (copy.supplier_id && !(await client.query('SELECT id FROM suppliers WHERE id=$1 AND tenant_id=$2 FOR KEY SHARE',
      [copy.supplier_id, tenantId])).rowCount) invoiceConflict()
    if (!(await client.query("SELECT id FROM auth.users WHERE id=$1 AND raw_app_meta_data->>'tenant_id'=$2 FOR KEY SHARE",
      [copy.user_id, tenantId])).rowCount) invoiceConflict()
    if (copy.shift_id && !(await client.query('SELECT id FROM shifts WHERE id=$1 AND tenant_id=$2 FOR KEY SHARE',
      [copy.shift_id, tenantId])).rowCount) invoiceConflict()

    const payment = (await client.query('SELECT * FROM supplier_payments WHERE id=$1 FOR UPDATE', [copy.payment_id])).rows[0]
    const cash = (await client.query('SELECT * FROM cash_operations WHERE id=$1 FOR UPDATE', [copy.payment_id])).rows[0]
    if (await financialCopyDeleted(client, tenantId, 'cash_operation', copy.payment_id)) invoiceConflict()
    const cashNote = copy.note ?? 'Оплата постачальнику'
    if (payment) {
      await assertPaymentStored(client,tenantId,copy,payment,cash,true)
      return
    }
    if (invoice.supplier_id !== copy.supplier_id || cash || copy.amount > invoice.total - invoice.paid_amount) invoiceConflict()
    const appliedAt = operation.applied_at ?? operation.created_at
    if (!invoiceDate.safeParse(appliedAt).success) invoiceInvalid()
    const previousPayments = (await client.query('SELECT * FROM supplier_payments WHERE invoice_id=$1 ORDER BY id', [copy.id])).rows
    const inserted = await client.query(`INSERT INTO supplier_payments
      (id,tenant_id,invoice_id,supplier_id,amount,payment_method,fund_source,shift_id,note,created_by,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,updated_at`,
      [copy.payment_id, tenantId, copy.id, copy.supplier_id, copy.amount, copy.payment_method,
        copy.fund_source, copy.shift_id, copy.note, copy.user_id, copy.created_at, appliedAt])
    if (inserted.rowCount !== 1 || inserted.rows[0].id !== copy.payment_id || !validWriteDate(inserted.rows[0].updated_at)) invoiceConflict()
    const updated = await client.query('UPDATE supply_invoices SET paid_amount=paid_amount+$1,payment_method=$2,updated_at=$3 WHERE id=$4 AND tenant_id=$5 RETURNING id,updated_at',
      [copy.amount, copy.payment_method, appliedAt, copy.id, tenantId])
    if (updated.rowCount !== 1 || updated.rows[0].id !== copy.id || !validWriteDate(updated.rows[0].updated_at)) invoiceConflict()
    let cashUpdatedAt: Date | null = null
    if (copy.fund_source === 'cashbox') {
      const cashResult = await client.query(`INSERT INTO cash_operations
        (id,tenant_id,shift_id,type,amount,note,created_by,source,created_at,updated_at)
        VALUES($1,$2,$3,'out',$4,$5,$6,'cashbox',$7,$8) RETURNING id,updated_at`,
        [copy.payment_id, tenantId, copy.shift_id, copy.amount, cashNote, copy.user_id, copy.created_at, appliedAt])
      if (cashResult.rowCount !== 1 || cashResult.rows[0].id !== copy.payment_id || !validWriteDate(cashResult.rows[0].updated_at)) invoiceConflict()
      cashUpdatedAt = cashResult.rows[0].updated_at
    }
    // All dependent facts must exist before acknowledging. No current-shift cash
    // calculation: this is a copy of a payment already made on the main PC.
    const after = (await client.query('SELECT * FROM supply_invoices WHERE id=$1', [copy.id])).rows[0]
    const payments = (await client.query('SELECT * FROM supplier_payments WHERE invoice_id=$1 ORDER BY id', [copy.id])).rows
    const savedPayment = payments.find(row => row.id === copy.payment_id)
    const savedCash = (await client.query('SELECT * FROM cash_operations WHERE id=$1', [copy.payment_id])).rows[0]
    await assertPaymentStored(client,tenantId,copy,savedPayment,savedCash,false)
    if (!isDeepStrictEqual(after, { ...invoice, paid_amount: invoice.paid_amount + copy.amount,
        payment_method: copy.payment_method, updated_at: updated.rows[0].updated_at })
      || !isDeepStrictEqual(payments.filter(row => row.id !== copy.payment_id), previousPayments)
      || !isDeepStrictEqual(savedPayment.updated_at, inserted.rows[0].updated_at)
      || (cashUpdatedAt && !isDeepStrictEqual(savedCash.updated_at,cashUpdatedAt))
      || snapshotHash(await readInvoiceState(client,tenantId,after)) !== snapshotHash(snapshot)) invoiceConflict()
  })
}
