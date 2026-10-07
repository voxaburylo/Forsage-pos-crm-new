import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { runTransaction } from '../../db/pg.js'
import { assertNoSupplierReferences } from '../supplierMergeSafety.js'
import type { SyncOutboxOperation } from './syncCore.js'
import {
  invoiceId, invoiceDate, invoiceMoney, invoiceSnapshot, parseInvoiceSnapshot,
  invoiceHash, snapshotHash, invoiceConflict, invoiceInvalid,
  lockInvoiceCopy, readInvoiceState, checkInvoiceReceipt, saveInvoiceReceipt,
} from './supplierInvoiceState.js'

const paymentSchema = z.object({
  id: invoiceId, invoice_id: invoiceId, supplier_id: invoiceId,
  amount: invoiceMoney.positive(), payment_method: z.enum(['cash','card','transfer']),
  fund_source: z.enum(['cashbox','owner_funds','bank_account','business_card']),
  shift_id: invoiceId.nullable(), note: z.string().nullable(), created_by: invoiceId.nullable(), created_at: invoiceDate,
}).strict()
const historySchema = z.object({
  history_version: z.literal(1), primary_supplier_id: invoiceId, duplicate_supplier_id: invoiceId,
  invoices: z.array(z.object({
    id: invoiceId, snapshot: invoiceSnapshot, status: z.enum(['draft','posted','cancelled','deleted']),
    deleted_at: invoiceDate.optional(),
    posted_by: invoiceId.nullable(), posted_at: invoiceDate.nullable(),
    paid_amount: invoiceMoney, payment_method: z.enum(['cash','card','transfer']).nullable(),
    payments: z.array(paymentSchema).max(5000),
  }).strict()).min(1).max(1000),
}).strict()
type History = z.infer<typeof historySchema>
const iso = (v: any) => v == null ? null : new Date(v).toISOString()
const paymentView = (p: any) => ({ id: p.id, invoice_id: p.invoice_id, supplier_id: p.supplier_id,
  amount: p.amount, payment_method: p.payment_method, fund_source: p.fund_source,
  shift_id: p.shift_id, note: p.note, created_by: p.created_by, created_at: iso(p.created_at) })
function checkpoint(operation: SyncOutboxOperation, invoiceId: string): SyncOutboxOperation {
  const hash = createHash('sha256').update('supplier-merge:' + operation.operation_id.toLowerCase() + ':' + invoiceId).digest('hex')
  const id = hash.slice(0,8)+'-'+hash.slice(8,12)+'-5'+hash.slice(13,16)+'-a'+hash.slice(17,20)+'-'+hash.slice(20,32)
  return { ...operation, operation_id: id, aggregate_id: invoiceId, operation_type: 'supplier_invoice.supplier_merged' }
}
function parseHistory(value: unknown): History {
  const result = historySchema.safeParse(value)
  if (!result.success) invoiceInvalid()
  const copy = result.data
  if (copy.primary_supplier_id === copy.duplicate_supplier_id
    || new Set(copy.invoices.map(i => i.id)).size !== copy.invoices.length) invoiceInvalid()
  const paymentIds = new Set<string>()
  for (const i of copy.invoices) {
    parseInvoiceSnapshot(i.snapshot)
    if (i.snapshot.supplier_id !== copy.duplicate_supplier_id || i.paid_amount > i.snapshot.total
      || (['draft','deleted'].includes(i.status) && (i.posted_by !== null || i.posted_at !== null))
      || (['cancelled','deleted'].includes(i.status) && i.paid_amount !== 0)
      || (i.status === 'deleted' ? i.deleted_at === undefined : i.deleted_at !== undefined)
      || i.payments.reduce((s,p) => s+p.amount,0) !== i.paid_amount
      || (i.paid_amount === 0 ? i.payment_method !== null : !i.payment_method)) invoiceInvalid()
    for (const p of i.payments) {
      if (paymentIds.has(p.id) || p.invoice_id !== i.id || p.supplier_id !== copy.duplicate_supplier_id) invoiceInvalid()
      paymentIds.add(p.id)
    }
  }
  return copy
}

/** A retry may use the ORIGINAL supplier only if this exact payment was in an
 * immutable merge manifest. Supplier aliases alone never authorize new spending. */
export async function mergedPaymentSupplierMatches(client: PoolClient, tenant: string, invoice: string,
  payment: string, original: string | null, current: string | null): Promise<boolean> {
  if (original === current) return true
  if (!original || !current) return false
  const visited = new Set<string>()
  let source = original
  while (!visited.has(source) && visited.size < 100) {
    visited.add(source)
    const row = (await client.query('SELECT primary_id,history_payload FROM supplier_merge_receipts WHERE tenant_id=$1 AND duplicate_id=$2',
      [tenant, source])).rows[0]
    if (!row?.history_payload) return false
    const parsed = historySchema.safeParse(row.history_payload)
    if (!parsed.success || parsed.data.duplicate_supplier_id !== source || parsed.data.primary_supplier_id !== row.primary_id
      || !parsed.data.invoices.some(i => i.id === invoice && i.payments.some(p => p.id === payment && p.supplier_id === source))) return false
    source = row.primary_id
    if (source === current) return true
  }
  return false
}

/** Mirror one explicitly completed local transfer. Never infer missing documents,
 * create payments, move stock, or rewrite old acknowledgement payloads. */
export async function applySupplierHistoryMerged(tenant: string, operation: SyncOutboxOperation): Promise<void> {
  const copy = parseHistory(operation.payload)
  if (operation.operation_type !== 'supplier.merged' || operation.aggregate_id?.toLowerCase() !== copy.primary_supplier_id
    || !invoiceId.safeParse(operation.operation_id).success || !invoiceDate.safeParse(operation.created_at).success
    || Buffer.byteLength(JSON.stringify(copy),'utf8') > 1_000_000) invoiceInvalid()
  const invoices = [...copy.invoices].sort((a,b) => a.id.localeCompare(b.id))
  await runTransaction(async client => {
    // Match all invoice writers: invoice locks BEFORE supplier row locks.
    for (const i of invoices) await lockInvoiceCopy(client, tenant, checkpoint(operation, i.id))
    const rows = (await client.query('SELECT * FROM suppliers WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
      [tenant,[copy.primary_supplier_id,copy.duplicate_supplier_id]])).rows
    const target = rows.find(r => r.id === copy.primary_supplier_id), source = rows.find(r => r.id === copy.duplicate_supplier_id)
    if (!target || !source) invoiceConflict()
    const saved = (await client.query('SELECT * FROM supplier_merge_receipts WHERE tenant_id=$1 AND duplicate_id=$2',
      [tenant,source.id])).rows[0]
    if (saved) {
      if (saved.primary_id !== target.id || !source.deleted_at || source.is_active !== false
        || saved.operation_id !== operation.operation_id.toLowerCase() || saved.device_id !== operation.device_id
        || Number(saved.source_sequence) !== operation.sequence || invoiceHash(saved.history_payload) !== invoiceHash(copy)) invoiceConflict()
      await assertNoSupplierReferences(client, source.id)
      for (const i of invoices) {
        const invoice = (await client.query('SELECT * FROM supply_invoices WHERE id=$1 FOR UPDATE',[i.id])).rows[0]
        if (!await checkInvoiceReceipt(client,tenant,checkpoint(operation,i.id),copy,invoice,true)) invoiceConflict()
      }
      return
    }
    if (source.deleted_at || target.deleted_at || !target.is_active) invoiceConflict()
    if ((await client.query('SELECT 1 FROM supplier_invoice_copy_receipts WHERE tenant_id=$1 AND operation_id=$2',[tenant,operation.operation_id])).rowCount) invoiceConflict()
    await assertNoSupplierReferences(client, source.id, ['supply_invoices','supplier_payments'])
    // A missing extra invoice (including another tenant/deleted draft) must not disappear.
    const all = (await client.query('SELECT id,tenant_id FROM supply_invoices WHERE supplier_id=$1 ORDER BY id',[source.id])).rows
    if (all.length !== invoices.length || all.some((r,n) => r.tenant_id !== tenant || r.id !== invoices[n].id)) invoiceConflict()
    const expectedPaymentIds = new Set(invoices.flatMap(i => i.payments.map(p => p.id)))
    const allPayments = (await client.query('SELECT id,tenant_id FROM supplier_payments WHERE supplier_id=$1',[source.id])).rows
    if (allPayments.length !== expectedPaymentIds.size || allPayments.some(p => p.tenant_id !== tenant || !expectedPaymentIds.has(p.id))) invoiceConflict()
    for (const i of invoices) {
      const invoice = (await client.query('SELECT * FROM supply_invoices WHERE id=$1 FOR UPDATE',[i.id])).rows[0]
      const state = await readInvoiceState(client,tenant,invoice,i.status==='deleted')
      if (snapshotHash(state) !== snapshotHash(i.snapshot) || invoice.status !== (i.status==='deleted'?'draft':i.status)
        || iso(invoice.deleted_at) !== (i.deleted_at ?? null)
        || invoice.posted_by !== i.posted_by || iso(invoice.posted_at) !== i.posted_at
        || invoice.paid_amount !== i.paid_amount || invoice.payment_method !== i.payment_method) invoiceConflict()
      if (await checkInvoiceReceipt(client,tenant,checkpoint(operation,i.id),copy,invoice,true)) invoiceConflict()
      const payments = (await client.query('SELECT * FROM supplier_payments WHERE invoice_id=$1 ORDER BY id FOR UPDATE',[i.id])).rows
      if (invoiceHash(payments.map(paymentView)) !== invoiceHash([...i.payments].sort((a,b) => a.id.localeCompare(b.id)))) invoiceConflict()
    }
    // Only pointers change. Numbers, actors, timestamps of payment, line IDs and quantities stay intact.
    for (const i of invoices) {
      await client.query('UPDATE supply_invoices SET supplier_id=$3,updated_at=$4 WHERE tenant_id=$1 AND id=$2',[tenant,i.id,target.id,operation.created_at])
      await client.query('UPDATE supplier_payments SET supplier_id=$3,updated_at=$4 WHERE tenant_id=$1 AND invoice_id=$2',[tenant,i.id,target.id,operation.created_at])
      await saveInvoiceReceipt(client,tenant,checkpoint(operation,i.id),copy)
    }
    await client.query('UPDATE suppliers SET deleted_at=$3,is_active=false,updated_at=$3 WHERE tenant_id=$1 AND id=$2',[tenant,source.id,operation.created_at])
    await client.query(`INSERT INTO supplier_merge_receipts(tenant_id,duplicate_id,primary_id,result,merged_at,operation_id,device_id,source_sequence,history_payload)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb)`,
      [tenant,source.id,target.id,JSON.stringify(target),operation.created_at,operation.operation_id,operation.device_id,operation.sequence,JSON.stringify(copy)])
  })
}
