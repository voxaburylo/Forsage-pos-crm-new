import { z } from 'zod'
import { mergedPaymentSupplierMatches } from './supplierHistoryMerge.js'
import { assertSupplierNotMerged } from '../supplierMergeSafety.js'
import type { PoolClient } from 'pg'
import { runTransaction } from '../../db/pg.js'
import { AppError } from '../../middleware/errorHandler.js'
import { isUuid, type SyncOutboxOperation } from './syncCore.js'
import { lockFinancialCopy } from './financialCopyGuards.js'
import { lockInvoiceCopy, checkInvoiceReceipt, saveInvoiceReceipt } from './supplierInvoiceState.js'

const id = z.string().refine(isUuid).transform(value => value.toLowerCase())
const date = z.string().refine(value => Number.isFinite(Date.parse(value)))
  .transform(value => new Date(value).toISOString())
const money = z.number().int().nonnegative().max(2_147_483_647)
const qty = z.number().positive().finite().max(999_999_999.999)
  .refine(value => Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001)
const schema = z.object({
  id, supplier_id: id.nullable(), invoice_number: z.string().max(100).nullable(),
  notes: z.string().nullable(), created_at: date,
  total: money.optional(), paid_amount: money,
  payment_id: id.nullable(), payment_method: z.enum(['cash', 'card', 'transfer']).nullable(),
  fund_source: z.enum(['cashbox', 'owner_funds', 'bank_account', 'business_card']),
  shift_id: id.nullable(), user_id: id.nullable().optional(),
  items: z.array(z.object({ id, product_id: id, qty, purchase_price: money, total: money, created_at: date })).min(1).max(5000),
})
type Copy = z.infer<typeof schema> & { total: number }
const iso = (value: any) => value == null ? null : new Date(value).toISOString()
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
function invalid(): never {
  throw new AppError('SYNC_INVOICE_COPY_INVALID',
    'Копія приходу потребує точних рядків, кількості, закупівлі та реквізитів початкової оплати. Оновіть локальну програму й повторіть передачу.', 422)
}
function conflict(): never {
  throw new AppError('SYNC_INVOICE_COPY_CONFLICT',
    'Копія приходу або його початкової оплати відрізняється від локального документа. Потрібна звірка; рядки, гроші та залишки не перезаписано.', 409)
}
const number = (value: any) => value === null || value === undefined || value === '' ? NaN : Number(value)
const headerValues = (row: any) => [row.id, row.tenant_id, row.supplier_id, row.invoice_number, number(row.total), row.notes, iso(row.created_at)]
const lineValues = (row: any) => [row.id, row.tenant_id, row.invoice_id, row.product_id, number(row.qty), number(row.purchase_price), number(row.total), iso(row.created_at)]
const paymentValues = (row: any) => [row.id, row.tenant_id, row.invoice_id, row.supplier_id, number(row.amount),
  row.payment_method, row.fund_source, row.shift_id, row.note, row.created_by, iso(row.created_at)]
const cashValues = (row: any) => [row.id, row.tenant_id, row.shift_id, row.type, number(row.amount), row.note,
  row.source, row.created_by, row.sale_id ?? null, row.employee_id ?? null, row.work_date ?? null, iso(row.created_at)]

function initialPayment(copy: Copy, tenantId: string) {
  return { id: copy.payment_id, tenant_id: tenantId, invoice_id: copy.id, supplier_id: copy.supplier_id,
    amount: copy.paid_amount, payment_method: copy.payment_method, fund_source: copy.fund_source,
    shift_id: copy.shift_id, note: 'Оплата під час створення накладної', created_by: copy.user_id, created_at: copy.created_at }
}
// Retain the established server mapping (cash row ID = payment ID), so retries
// cannot introduce a second cash movement for invoices copied by older builds.
function initialCash(copy: Copy, tenantId: string) {
  return { id: copy.payment_id, tenant_id: tenantId, shift_id: copy.shift_id, type: 'out',
    amount: copy.paid_amount, note: 'Оплата постачальнику під час створення накладної',
    source: 'cashbox', created_by: copy.user_id, created_at: copy.created_at }
}

async function validateReferences(client: PoolClient, copy: Copy, tenantId: string, acknowledged = false) {
  const productIds = [...new Set(copy.items.map(item => item.product_id))]
  const products = await client.query('SELECT id FROM products WHERE tenant_id=$1 AND id=ANY($2::uuid[]) FOR KEY SHARE', [tenantId, productIds])
  if (products.rowCount !== productIds.length)
    throw new AppError('SYNC_PRODUCT_NOT_FOUND', 'Спочатку передайте картки всіх товарів приходу.', 409)
  if (copy.supplier_id) {

    const supplier = await client.query('SELECT id FROM suppliers WHERE id=$1 AND tenant_id=$2 FOR KEY SHARE', [copy.supplier_id, tenantId])
    if (!supplier.rowCount) throw new AppError('SYNC_SUPPLIER_NOT_FOUND', 'Постачальник приходу відсутній у копії цього магазину.', 409)
    if (!acknowledged) await assertSupplierNotMerged(client, tenantId, copy.supplier_id)
  }
}

async function verifyExisting(client: PoolClient, copy: Copy, tenantId: string, saved: any, acknowledged = false) {
  if (saved.tenant_id !== tenantId || (saved.deleted_at && !acknowledged) || !['draft', 'posted', 'cancelled'].includes(saved.status)
    || (!acknowledged && !same(headerValues(saved), headerValues({ ...copy, tenant_id: tenantId })))) conflict()
  const lines = (await client.query('SELECT * FROM supply_invoice_items WHERE invoice_id=$1 ORDER BY id', [copy.id])).rows
  const expected = copy.items.map(item => lineValues({ ...item, tenant_id: tenantId, invoice_id: copy.id }))
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  if (!acknowledged && (lines.some(row => row.deleted_at) || !same(lines.map(lineValues), expected))) conflict()
  const payments = (await client.query('SELECT * FROM supplier_payments WHERE invoice_id=$1 ORDER BY id', [copy.id])).rows
  let paid = 0
  for (const payment of payments) {
    const amount = number(payment.amount)
    if (payment.deleted_at || payment.tenant_id !== tenantId || payment.supplier_id !== saved.supplier_id
      || !Number.isSafeInteger(amount) || amount <= 0) conflict()
    paid += amount
  }
  if (!Number.isSafeInteger(paid) || paid > number(saved.total) || number(saved.paid_amount) !== paid || paid < copy.paid_amount
    || (saved.status === 'cancelled' && paid > 0)) conflict()
  if (copy.paid_amount > 0) {
    const payment = payments.find(row => row.id === copy.payment_id)
    const expected = initialPayment(copy, tenantId)
    if (payment && acknowledged && await mergedPaymentSupplierMatches(client, tenantId, copy.id, payment.id, expected.supplier_id, payment.supplier_id))
      expected.supplier_id = payment.supplier_id
    if (!payment || !same(paymentValues(payment), paymentValues(expected))) conflict()
  }
  // Later valid payments may change the invoice's payment method.
  if (payments.length === (copy.paid_amount > 0 ? 1 : 0) && saved.payment_method !== copy.payment_method) conflict()
  if (copy.payment_id) {
    const cash = (await client.query('SELECT * FROM cash_operations WHERE id=$1 FOR UPDATE', [copy.payment_id])).rows[0]
    if (copy.fund_source === 'cashbox') {
      if (!cash || cash.deleted_at || !same(cashValues(cash), cashValues(initialCash(copy, tenantId)))) conflict()
    } else if (cash) conflict()
  }
}

/** A committed local creation is a historical document, never a request to pay
 * again from today's cashbox. All rows and its initial payment commit together. */
export async function applySupplierInvoiceCreated(tenantId: string, _uploader: string, operation: SyncOutboxOperation): Promise<void> {
  if (operation.tenant_id !== tenantId || !isUuid(operation.aggregate_id)) invalid()
  const payload = operation.payload ?? {}
  const createdAt = payload.created_at === undefined ? operation.created_at : payload.created_at
  const parsed = schema.safeParse({ ...payload, id: payload.id ?? operation.aggregate_id, created_at: createdAt,
    supplier_id: payload.supplier_id ?? null, invoice_number: payload.invoice_number ?? null, notes: payload.notes ?? null,
    paid_amount: payload.paid_amount === undefined ? 0 : payload.paid_amount, payment_id: payload.payment_id ?? null,
    payment_method: payload.payment_method ?? null,
    fund_source: payload.fund_source ?? (payload.payment_method === 'cash' ? 'cashbox' : 'bank_account'),
    shift_id: payload.shift_id ?? null,
    // Legacy creation producers stored every line at the creation instant.
    items: Array.isArray(payload.items) ? payload.items.map((item: any) => ({ ...item, created_at: item?.created_at === undefined ? createdAt : item.created_at })) : payload.items,
  })
  if (!parsed.success) invalid()
  const draft = parsed.data
  const total = draft.items.reduce((sum, item) => sum + item.total, 0)
  if (!Number.isSafeInteger(total) || total > 2_147_483_647 || draft.id !== operation.aggregate_id.toLowerCase()
    || new Set(draft.items.map(item => item.id)).size !== draft.items.length
    || draft.items.some(item => Math.round(item.qty * item.purchase_price) !== item.total)
    || (draft.total !== undefined && draft.total !== total) || draft.paid_amount > total) invalid()
  if (draft.paid_amount > 0) {
    if (!draft.payment_id || !draft.payment_method || !draft.user_id
      || (draft.fund_source === 'cashbox' && (!draft.shift_id || draft.payment_method !== 'cash'))) invalid()
  } else if (draft.payment_id !== null || draft.payment_method !== null) invalid()
  const copy: Copy = { ...draft, total }
  await runTransaction(async client => {
    await lockInvoiceCopy(client, tenantId, operation)
    if (copy.payment_id) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['supplier-payment-copy:' + copy.payment_id])
      await lockFinancialCopy(client, 'cash_operation', copy.payment_id)
    }
    const existing = (await client.query('SELECT * FROM supply_invoices WHERE id=$1 FOR UPDATE', [copy.id])).rows[0]
    const acknowledged = await checkInvoiceReceipt(client, tenantId, operation, copy, existing)
    await validateReferences(client, copy, tenantId, acknowledged)
    if (existing) {
      await verifyExisting(client, copy, tenantId, existing, acknowledged)
      if (!acknowledged) await saveInvoiceReceipt(client, tenantId, operation, copy)
      return
    }
    if ((await client.query('SELECT id FROM supply_invoice_items WHERE id=ANY($1::uuid[])', [copy.items.map(item => item.id)])).rowCount) conflict()
    if (copy.payment_id) {
      if ((await client.query('SELECT id FROM supplier_payments WHERE id=$1', [copy.payment_id])).rowCount
        || (await client.query('SELECT id FROM cash_operations WHERE id=$1', [copy.payment_id])).rowCount) conflict()
      const staff = await client.query("SELECT id FROM auth.users WHERE id=$1 AND raw_app_meta_data->>'tenant_id'=$2", [copy.user_id, tenantId])
      if (!staff.rowCount) throw new AppError('SYNC_INVOICE_COPY_REQUIRED', 'Працівник початкової оплати відсутній у копії цього магазину.', 409)
      if (copy.shift_id) {
        const shift = await client.query('SELECT id FROM shifts WHERE id=$1 AND tenant_id=$2', [copy.shift_id, tenantId])
        if (!shift.rowCount) throw new AppError('SYNC_INVOICE_COPY_REQUIRED', 'Спочатку потрібна копія первісної касової зміни.', 409)
      }
    }
    const appliedAt = operation.applied_at ?? operation.created_at
    await client.query(`INSERT INTO supply_invoices(id,tenant_id,supplier_id,invoice_number,status,total,paid_amount,payment_method,notes,created_at,updated_at)
      VALUES($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10)`,
      [copy.id, tenantId, copy.supplier_id, copy.invoice_number, total, copy.paid_amount, copy.payment_method, copy.notes, copy.created_at, appliedAt])
    for (const item of copy.items) await client.query(
      'INSERT INTO supply_invoice_items(id,tenant_id,invoice_id,product_id,qty,purchase_price,total,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      lineValues({ ...item, tenant_id: tenantId, invoice_id: copy.id }))
    if (copy.paid_amount > 0) {
      await client.query(`INSERT INTO supplier_payments(id,tenant_id,invoice_id,supplier_id,amount,payment_method,fund_source,shift_id,note,created_by,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [...paymentValues(initialPayment(copy, tenantId)), appliedAt])
      if (copy.fund_source === 'cashbox') await client.query(
        `INSERT INTO cash_operations(id,tenant_id,shift_id,type,amount,note,source,created_by,created_at,updated_at)
         VALUES($1,$2,$3,'out',$4,$5,'cashbox',$6,$7,$8)`,
        [copy.payment_id, tenantId, copy.shift_id, copy.paid_amount, initialCash(copy, tenantId).note, copy.user_id, copy.created_at, appliedAt])
    }
    await saveInvoiceReceipt(client, tenantId, operation, copy)
  })
}
