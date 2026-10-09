import { isDeepStrictEqual } from 'node:util'
import type { LocalDatabase } from '../db/localDatabase'
import { normalizeSupplyItem } from './supplyValidation'

export const supplierPaymentConflict = () => new Error('Оплату не підтверджено: накладна, оплата та касовий рух не узгоджені. Зміни цієї спроби скасовано; потрібна звірка.')

export function readSupplierPaymentState(db: LocalDatabase, id: string, tenant: string) {
  const header = db.prepare('SELECT * FROM supply_invoices WHERE id=?').get(id) as any
  const lines = db.prepare('SELECT * FROM supply_invoice_items WHERE invoice_id=? ORDER BY id').all(id) as any[]
  const payments = db.prepare('SELECT * FROM supplier_payments WHERE invoice_id=? ORDER BY id').all(id) as any[]
  if (!header || header.tenant_id !== tenant || header.deleted_at || !['draft','posted','cancelled'].includes(header.status)
    || !Number.isSafeInteger(header.total) || header.total < 0 || !Number.isSafeInteger(header.paid_amount) || header.paid_amount < 0
    || header.paid_amount > header.total || (header.status === 'cancelled' && header.paid_amount > 0)
    || !lines.length || lines.some(row => row.tenant_id !== tenant || row.deleted_at)
    || payments.some(row => row.tenant_id !== tenant || row.deleted_at || row.supplier_id !== header.supplier_id
      || !Number.isSafeInteger(row.amount) || row.amount <= 0
      || !['cash','card','transfer'].includes(row.payment_method)
      || !['cashbox','owner_funds','bank_account','business_card'].includes(row.fund_source))
    || payments.reduce((sum,row)=>sum+row.amount,0) !== header.paid_amount) throw supplierPaymentConflict()
  let total = 0
  for (const row of lines) {
    const valid = normalizeSupplyItem(row)
    if (valid.qty !== row.qty || valid.purchase_price !== row.purchase_price || valid.total !== row.total) throw supplierPaymentConflict()
    total += row.total
  }
  if (total !== header.total || !Number.isSafeInteger(total)
    || (header.paid_amount === 0 ? header.payment_method !== null : !['cash','card','transfer'].includes(header.payment_method))) throw supplierPaymentConflict()
  return {header,lines,payments}
}

/** Legacy local cash rows have independent IDs. Match the full immutable cohort,
 * including multiplicity, so two identical payments cannot share one cash row. */
export function verifySupplierPaymentCash(db: LocalDatabase, tenant: string, payment: any) {
  if (payment.fund_source !== 'cashbox') return
  if (payment.payment_method !== 'cash' || !payment.shift_id) throw supplierPaymentConflict()
  const note = payment.note ?? 'Оплата постачальнику'
  const expected = db.prepare(`SELECT COUNT(*) n FROM supplier_payments
    WHERE tenant_id=? AND supplier_id IS ? AND amount=? AND shift_id IS ? AND created_by IS ? AND created_at=?
      AND COALESCE(note,'Оплата постачальнику')=? AND fund_source='cashbox' AND deleted_at IS NULL`)
    .get(tenant,payment.supplier_id,payment.amount,payment.shift_id,payment.created_by,payment.created_at,note) as any
  const cash = db.prepare(`SELECT * FROM cash_operations
    WHERE tenant_id=? AND supplier_id IS ? AND amount=? AND shift_id IS ? AND user_id IS ? AND created_at=?
      AND notes=? AND type='supplier_payment' AND source='cashbox' AND deleted_at IS NULL`)
    .all(tenant,payment.supplier_id,payment.amount,payment.shift_id,payment.created_by,payment.created_at,note) as any[]
  if (!expected.n || cash.length !== expected.n || cash.some(row => row.sale_id || row.employee_id)) throw supplierPaymentConflict()
}

export function verifySupplierPaymentRows(db: LocalDatabase, payment: Record<string, unknown>, cash: Record<string, unknown> | null) {
  const actual = db.prepare('SELECT * FROM supplier_payments WHERE id=?').get(payment.id as string) as any
  if (!actual || Object.entries(payment).some(([key,value])=>actual[key]!==value)) throw supplierPaymentConflict()
  if (cash) {
    const actualCash = db.prepare('SELECT * FROM cash_operations WHERE id=?').get(cash.id as string) as any
    if (!actualCash || Object.entries(cash).some(([key,value])=>actualCash[key]!==value)) throw supplierPaymentConflict()
    verifySupplierPaymentCash(db,payment.tenant_id as string,actual)
  }
}

export function verifySupplierPaymentState(before: ReturnType<typeof readSupplierPaymentState>, after: ReturnType<typeof readSupplierPaymentState>,
  paymentId: string, amount: number, method: string, timestamp: string) {
  if (!isDeepStrictEqual({...after.header},{...before.header,paid_amount:before.header.paid_amount+amount,
      payment_method:method,dirty_at:timestamp,updated_at:timestamp})
    || !isDeepStrictEqual(after.lines,before.lines)
    || after.payments.filter(row=>row.id===paymentId).length !== 1
    || !isDeepStrictEqual(after.payments.filter(row=>row.id!==paymentId),before.payments)) throw supplierPaymentConflict()
}
