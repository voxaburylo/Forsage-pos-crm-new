import type { LocalDatabase } from '../db/localDatabase'
import { assertSupplierHasNoHistory, supplierMergeHistoryError } from './supplierMergeSafety'
import { normalizeSupplyItem, checkedSupplyMoney } from './supplyValidation'
import { listDeletedSupplierHistory } from './deletedSupplierHistory'

const conflict = () => new Error('Історія постачальника неузгоджена. Злиття зупинено; накладні, оплати й залишки не змінено.')
const money = (v: number) => {
  if (!Number.isSafeInteger(v) || checkedSupplyMoney(v, 'Сума') !== v) throw conflict()
  return v
}

/** Caller owns one transaction spanning this snapshot, all pointers, outbox and receipt. */
export function prepareSupplierHistory(db: LocalDatabase, tenant: string, source: string, target: string) {
  const documents = db.prepare('SELECT * FROM supply_invoices WHERE supplier_id=? ORDER BY id').all(source) as any[]
  const deleted = listDeletedSupplierHistory(db,tenant,source)
  assertSupplierHasNoHistory(db, tenant, source, ['supply_invoices','supplier_payments','cash_operations'],
    new Set(documents.filter(i => i.tenant_id === tenant && !i.deleted_at && i.status === 'cancelled').map(i => i.id)),new Set(deleted.map(i=>i.id)))
  const payments = db.prepare('SELECT * FROM supplier_payments WHERE supplier_id=? ORDER BY id').all(source) as any[]
  const cash = db.prepare('SELECT * FROM cash_operations WHERE supplier_id=? ORDER BY id').all(source) as any[]
  const expectedPaymentIds = new Set<string>()
  const invoices = documents.map(invoice => {
    if (invoice.tenant_id !== tenant || invoice.deleted_at || !['draft','posted','cancelled'].includes(invoice.status)) throw supplierMergeHistoryError()
    if (invoice.status === 'draft' && (invoice.posted_by || invoice.posted_at)) throw conflict()
    const lines = db.prepare('SELECT * FROM supply_invoice_items WHERE invoice_id=? ORDER BY id').all(invoice.id) as any[]
    if (!lines.length || lines.length > 5000 || lines.some(l => l.tenant_id !== tenant || l.deleted_at)) throw conflict()
    let total = 0
    for (const line of lines) {
      const normalized = normalizeSupplyItem(line)
      if (normalized.qty !== line.qty || normalized.purchase_price !== money(line.purchase_price) || normalized.total !== money(line.total)) throw conflict()
      total += line.total
    }
    if (money(total) !== invoice.total) throw conflict()
    const documentPayments = db.prepare('SELECT * FROM supplier_payments WHERE invoice_id=? ORDER BY id').all(invoice.id) as any[]
    let paid = 0
    for (const p of documentPayments) {
      if (p.tenant_id !== tenant || p.supplier_id !== source || p.deleted_at || money(p.amount) <= 0
        || !['cash','card','transfer'].includes(p.payment_method)
        || !['cashbox','owner_funds','bank_account','business_card'].includes(p.fund_source)) throw conflict()
      paid += p.amount
      expectedPaymentIds.add(p.id)
    }
    if (money(paid) !== invoice.paid_amount || paid > total || (invoice.status === 'cancelled' && paid !== 0)
      || (paid === 0 ? invoice.payment_method !== null : !['cash','card','transfer'].includes(invoice.payment_method))) throw conflict()
    // Legacy incomplete events still need their original identities for enrichment.
    // Wait for those to copy before moving; do not mutate old queue payloads.
    const queue = db.prepare("SELECT * FROM sync_outbox WHERE tenant_id=? AND aggregate_id=? AND status<>'synced'").all(tenant, invoice.id) as any[]
    for (const event of queue) {
      let p: any
      try { p = JSON.parse(event.payload_json) } catch { throw conflict() }
      if ((event.operation_type === 'supplier_invoice.created' && p.paid_amount > 0 && p.user_id === undefined)
        || (event.operation_type === 'supplier_invoice.payment_added' && (p.supplier_id === undefined || p.user_id === undefined)))
        throw new Error('Спочатку завершіть передачу старих оплат постачальника. Потім повторіть злиття; нічого не змінено.')
    }
    return { id: invoice.id, status: invoice.status as 'draft' | 'posted' | 'cancelled', posted_by: invoice.posted_by ?? null, posted_at: invoice.posted_at ?? null,
      paid_amount: paid, payment_method: invoice.payment_method,
      snapshot: { supplier_id: source, invoice_number: invoice.invoice_number ?? null, notes: invoice.notes ?? null,
        total, created_at: invoice.created_at, items: lines.map(l => ({ id: l.id, product_id: l.product_id,
          qty: l.qty, purchase_price: l.purchase_price, total: l.total, created_at: l.created_at })) },
      payments: documentPayments.map(p => ({ id: p.id, invoice_id: p.invoice_id, supplier_id: p.supplier_id,
        amount: p.amount, payment_method: p.payment_method, fund_source: p.fund_source, shift_id: p.shift_id ?? null,
        note: p.note ?? null, created_by: p.created_by ?? null, created_at: p.created_at })) }
  })
  if (payments.length !== expectedPaymentIds.size || payments.some(p => !expectedPaymentIds.has(p.id))) throw conflict()
  // Cash has a different local ID. Check a multiset of immutable facts, not amount alone.
  const key = (amount: number, shift: string|null, actor: string|null, note: string, date: string) => JSON.stringify([amount,shift,actor,note,date])
  const expectedCash = payments.filter(p => p.fund_source === 'cashbox')
    .map(p => key(p.amount,p.shift_id,p.created_by,p.note ?? 'Оплата постачальнику',p.created_at)).sort()
  if (cash.some(c => c.tenant_id !== tenant || c.deleted_at || c.type !== 'supplier_payment' || c.source !== 'cashbox'
    || c.sale_id || c.employee_id)
    || JSON.stringify(cash.map(c => key(c.amount,c.shift_id,c.user_id,c.notes,c.created_at)).sort()) !== JSON.stringify(expectedCash)) throw conflict()
  const allInvoices = [...invoices,...deleted].sort((a,b)=>a.id.localeCompare(b.id))
  if (!allInvoices.length) return null
  if (new Set(allInvoices.map(i=>i.id)).size !== allInvoices.length) throw conflict()
  const payload = { history_version: 1 as const, primary_supplier_id: target, duplicate_supplier_id: source, invoices: allInvoices }
  if (allInvoices.length > 1000 || Buffer.byteLength(JSON.stringify(payload),'utf8') > 1_000_000)
    throw new Error('Історія надто велика для одного безпечного злиття. Потрібна окрема перевірка; нічого не змінено.')
  return { payload, cash }
}

export function applySupplierHistory(db: LocalDatabase, tenant: string, source: string, target: string, timestamp: string) {
  db.prepare('UPDATE supply_invoices SET supplier_id=?,dirty_at=?,updated_at=? WHERE tenant_id=? AND supplier_id=?')
    .run(target,timestamp,timestamp,tenant,source)
  db.prepare('UPDATE supplier_payments SET supplier_id=?,dirty_at=?,updated_at=? WHERE tenant_id=? AND supplier_id=?')
    .run(target,timestamp,timestamp,tenant,source)
  db.prepare('UPDATE cash_operations SET supplier_id=?,dirty_at=?,updated_at=? WHERE tenant_id=? AND supplier_id=?')
    .run(target,timestamp,timestamp,tenant,source)
}
