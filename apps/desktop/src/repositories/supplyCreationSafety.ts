import { isDeepStrictEqual } from 'node:util'
import type { LocalDatabase } from '../db/localDatabase'
import { readSupplierPaymentState } from './supplierPaymentSafety'

export const supplyCreationConflict = (cause?: unknown) => new Error('Накладну не збережено повністю. Зміни цієї спроби скасовано; повторіть збереження. Якщо помилка повторюється, потрібна перевірка бази.', {cause})

interface CreationFacts {
  header: Record<string, unknown> & { id: string; tenant_id: string; created_at: string }
  lines: Array<Record<string, unknown> & { id: string }>
  paymentId: string | null
  operationId: string
  payload: unknown
}

/** Validate the requested facts, not just totals or a filtered UI projection. */
export function verifyCreatedSupply(db: LocalDatabase, expected: CreationFacts): void {
  const { header, lines, paymentId, operationId, payload } = expected
  let actual: ReturnType<typeof readSupplierPaymentState>
  try { actual = readSupplierPaymentState(db, header.id, header.tenant_id) }
  catch (error) { throw supplyCreationConflict(error) }
  const byId = new Map(actual.lines.map(row => [row.id, row]))
  const queued = db.prepare("SELECT * FROM sync_outbox WHERE aggregate_type='supply_invoice' AND aggregate_id=?").all(header.id) as any[]
  const queue = queued.find(row => row.operation_id === operationId)
  const expectedQueue = {
    operation_id: operationId, tenant_id: header.tenant_id, device_id: db.deviceId,
    aggregate_type: 'supply_invoice', aggregate_id: header.id, operation_type: 'supplier_invoice.created',
    payload_json: JSON.stringify(payload), status: 'pending', attempts: 0,
    next_attempt_at: null, created_at: header.created_at, synced_at: null, last_error: null,
  }
  if (!isDeepStrictEqual({...actual.header}, header)
    || actual.lines.length !== lines.length || new Set(lines.map(row => row.id)).size !== lines.length
    || lines.some(row => !isDeepStrictEqual({...byId.get(row.id)}, row))
    || actual.payments.length !== (paymentId ? 1 : 0)
    || (paymentId && actual.payments[0].id !== paymentId)
    || queued.length !== 1 || !queue || !Number.isSafeInteger(queue.sequence) || queue.sequence <= 0
    || Object.entries(expectedQueue).some(([key, value]) => queue[key] !== value)) throw supplyCreationConflict()
}

/** The operation receipt is written after the document. Guard against a late
 * storage-side change to already verified facts, including the AI draft path.
 * Used for new writes only: a legitimate replay must not restore an older draft. */
export function captureSupplyCreation(db: LocalDatabase, invoiceId: string, tenant: string): () => void {
  const read = () => ({
    header: db.prepare('SELECT * FROM supply_invoices WHERE id=?').get(invoiceId),
    lines: db.prepare('SELECT * FROM supply_invoice_items WHERE invoice_id=? ORDER BY id').all(invoiceId),
    payments: db.prepare('SELECT * FROM supplier_payments WHERE invoice_id=? ORDER BY id').all(invoiceId),
    queue: db.prepare("SELECT * FROM sync_outbox WHERE aggregate_type='supply_invoice' AND aggregate_id=? ORDER BY sequence").all(invoiceId),
    products: db.prepare('SELECT * FROM products WHERE id IN (SELECT product_id FROM supply_invoice_items WHERE invoice_id=?) ORDER BY id').all(invoiceId),
    cash: db.prepare(`SELECT c.* FROM cash_operations c WHERE c.tenant_id=? AND EXISTS (
      SELECT 1 FROM supplier_payments p WHERE p.invoice_id=? AND p.tenant_id=c.tenant_id AND p.fund_source='cashbox'
        AND c.supplier_id IS p.supplier_id AND c.shift_id IS p.shift_id AND c.user_id IS p.created_by
        AND c.created_at=p.created_at AND c.notes=COALESCE(p.note,'Оплата постачальнику')
      ) ORDER BY c.id`).all(tenant, invoiceId),
  })
  const before = read()
  return () => { if (!isDeepStrictEqual(read(), before)) throw supplyCreationConflict() }
}
