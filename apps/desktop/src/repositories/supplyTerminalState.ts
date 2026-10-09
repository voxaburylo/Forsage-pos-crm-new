import type { LocalDatabase } from '../db/localDatabase'
import { documentRevision } from './documentRevision'
import { normalizeSupplyItem, checkedSupplyMoney } from './supplyValidation'

export interface SupplyTerminalReceipt {
  kind: 'cancelled' | 'deleted'
  before_revision: string
  after_fingerprint: string | null
  payload: Record<string, unknown>
  current_supplier_id?: string | null
  movement_fingerprint?: string
}
const key = (tenant: string, id: string) => 'supply-terminal:' + tenant + ':' + id
const hash = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const conflict = () => new Error('Стан накладної змінився або не підтверджений. Оновіть список і перевірте документ; залишки не змінено.')

/** Kept independently of the transient outbox so a lost reply remains safe after sync. */
export function readSupplyTerminalReceipt(db: LocalDatabase, tenant: string, id: string): SupplyTerminalReceipt | null {
  const row = db.prepare('SELECT value_json FROM app_meta WHERE key = ?').get(key(tenant, id)) as any
  if (!row) return null
  let receipt: SupplyTerminalReceipt
  try { receipt = JSON.parse(row.value_json) } catch { throw conflict() }
  if (!receipt || !['cancelled', 'deleted'].includes(receipt.kind) || !hash(receipt.before_revision)
    || (receipt.kind === 'cancelled' ? !hash(receipt.after_fingerprint) : receipt.after_fingerprint !== null)
    || !receipt.payload || receipt.payload.id !== id
    || (receipt.movement_fingerprint !== undefined && (receipt.kind !== 'cancelled' || !hash(receipt.movement_fingerprint)))
    || (receipt.current_supplier_id !== undefined && (receipt.kind !== 'deleted'
      || !(receipt.current_supplier_id === null || (typeof receipt.current_supplier_id === 'string' && receipt.current_supplier_id.trim()))))) throw conflict()
  return receipt
}
export function saveSupplyTerminalReceipt(db: LocalDatabase, tenant: string, id: string, receipt: SupplyTerminalReceipt, timestamp: string) {
  const json = JSON.stringify(receipt)
  const changed = db.prepare('INSERT INTO app_meta(key, value_json, updated_at) VALUES (?, ?, ?)')
    .run(key(tenant, id), json, timestamp)
  const actual = db.prepare('SELECT value_json,updated_at FROM app_meta WHERE key=?').get(key(tenant, id)) as any
  if (changed.changes !== 1 || !actual || actual.value_json !== json || actual.updated_at !== timestamp) throw conflict()
}
/** Include immutable movement facts, not dirty/sync timestamps or the current stock.
 * Later sales may change stock; sync may clear dirty_at without changing this history. */
export function supplyMovementFingerprint(rows: any[]): string {
  return documentRevision([...rows].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(row => [
    row.id, row.tenant_id, row.product_id, row.source_type, row.source_id, row.qty_delta,
    row.qty_after, row.unit_cost, row.notes, row.created_at, row.deleted_at,
  ]))
}
export function assertSupplyTerminalMovements(db: LocalDatabase, id: string, receipt: SupplyTerminalReceipt) {
  // Legacy receipts have no recorded fingerprint; do not invent one from current data.
  if (receipt.movement_fingerprint !== undefined
    && receipt.movement_fingerprint !== supplyMovementFingerprint(db.prepare('SELECT * FROM inventory_movements WHERE source_id=?').all(id))) throw conflict()
}
export function assertDeletedSupplyAbsent(db: LocalDatabase, id: string) {
  if (db.prepare('SELECT 1 FROM supply_invoices WHERE id=?').get(id)
    || db.prepare('SELECT 1 FROM supply_invoice_items WHERE invoice_id=? LIMIT 1').get(id)
    || db.prepare('SELECT 1 FROM supplier_payments WHERE invoice_id=? LIMIT 1').get(id)
    || db.prepare('SELECT 1 FROM inventory_movements WHERE source_id=? LIMIT 1').get(id)) throw conflict()
}

/** Advance only the fingerprint after an independently validated supplier-only transfer.
 * Keep the original cancellation request intact for lost-reply retries. */
export function advanceSupplyTerminalSupplier(db: LocalDatabase, tenant: string, before: any, after: any, timestamp: string) {
  const receipt = readSupplyTerminalReceipt(db, tenant, before.id)
  if (!receipt) return // Legacy cancelled document has no durable retry receipt.
  assertSupplyTerminalRetry(receipt, 'cancelled', undefined, before)
  assertSupplyTerminalMovements(db, before.id, receipt)
  if (after.id !== before.id || after.status !== 'cancelled') throw conflict()
  const next = { ...receipt, after_fingerprint: supplyTerminalFingerprint(after) }
  const changed = db.prepare('UPDATE app_meta SET value_json=?,updated_at=? WHERE key=? AND value_json=?')
    .run(JSON.stringify(next), timestamp, key(tenant, before.id), JSON.stringify(receipt))
  if (changed.changes !== 1) throw conflict()
}
export function supplyTerminalFingerprint(invoice: any): string {
  return documentRevision([invoice.edit_revision, invoice.created_at, invoice.posted_by, invoice.posted_at,
    [...invoice.items].sort((a, b) => a.id.localeCompare(b.id)).map(item => [item.id, item.created_at])])
}
export function assertSupplyTerminalRetry(receipt: SupplyTerminalReceipt, kind: SupplyTerminalReceipt['kind'], expected?: string, invoice?: any) {
  if (receipt.kind !== kind || (expected !== undefined && expected !== receipt.before_revision
    && !(kind === 'cancelled' && expected === invoice?.edit_revision))
    || (kind === 'cancelled' && (invoice?.status !== 'cancelled' || supplyTerminalFingerprint(invoice) !== receipt.after_fingerprint))) throw conflict()
}

/** Never remove payment history just because a damaged header says zero. */
export function assertUnpaidSupplyTerminal(db: LocalDatabase, tenant: string, invoice: any) {
  const payments = db.prepare('SELECT id FROM supplier_payments WHERE invoice_id = ? LIMIT 1').get(invoice.id)
  if (invoice.paid_amount !== 0 || invoice.payment_method !== null || payments)
    throw new Error('Не можна скасувати або видалити накладну з оплатою. Спочатку звірте оплату.')
  const lines = db.prepare('SELECT * FROM supply_invoice_items WHERE invoice_id = ?').all(invoice.id) as any[]
  if (!lines.length || lines.length !== invoice.items.length || lines.some(item => item.tenant_id !== tenant || item.deleted_at))
    throw conflict()
  const sum = lines.reduce((total, item) => {
    const normalized = normalizeSupplyItem(item)
    if (!Number.isSafeInteger(item.purchase_price) || !Number.isSafeInteger(item.total)) throw conflict()
    return total + normalized.total
  }, 0)
  if (checkedSupplyMoney(sum, 'Сума накладної') !== invoice.total) throw conflict()
}
