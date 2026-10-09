import { isDeepStrictEqual } from 'node:util'
import type { LocalDatabase } from '../db/localDatabase'
import { readSupplierPaymentState } from './supplierPaymentSafety'
import { stockQuantity } from './stockQuantity'

export const supplyWriteConflict = (cause?: unknown) => new Error('Накладну не змінено: збережені рядки, залишки або рух товару не відповідають операції. Зміни цієї спроби скасовано; потрібна перевірка.', {cause})
const plain = (rows: any[]) => rows.map(row => ({...row}))

/** Raw view also supports proving complete absence after a draft deletion. */
function readSupplyWriteSnapshot(db: LocalDatabase, id: string, tenant: string, productIds: string[]) {
  const header = db.prepare('SELECT * FROM supply_invoices WHERE id=?').get(id) as any
  return {
    header: header ? {...header} : null,
    lines: plain(db.prepare('SELECT * FROM supply_invoice_items WHERE invoice_id=? ORDER BY id').all(id)),
    payments: plain(db.prepare('SELECT * FROM supplier_payments WHERE invoice_id=? ORDER BY id').all(id)),
    products: plain(db.prepare('SELECT * FROM products WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify(productIds))),
    movements: plain(db.prepare('SELECT * FROM inventory_movements WHERE source_id=? ORDER BY id').all(id)),
    queue: plain(db.prepare("SELECT * FROM sync_outbox WHERE aggregate_type='supply_invoice' AND aggregate_id=? ORDER BY sequence").all(id)),
    supplierChanges: db.prepare('SELECT * FROM app_meta WHERE key=?').get('invoice-supplier-changes:' + tenant + ':' + id),
    cash: plain(db.prepare(`SELECT DISTINCT c.* FROM supplier_payments p JOIN cash_operations c
      ON c.tenant_id=p.tenant_id AND c.supplier_id IS p.supplier_id AND c.shift_id IS p.shift_id
        AND c.user_id IS p.created_by AND c.created_at=p.created_at
        AND c.notes=COALESCE(p.note,'Оплата постачальнику')
      WHERE p.invoice_id=? AND p.tenant_id=? AND p.fund_source='cashbox' ORDER BY c.id`).all(id, tenant)),
  }
}

/** Read all rows, including hidden or foreign rows; never validate a UI projection. */
export function readSupplyWriteState(db: LocalDatabase, id: string, tenant: string, productIds?: string[]) {
  let invoice: ReturnType<typeof readSupplierPaymentState>
  try { invoice = readSupplierPaymentState(db, id, tenant) }
  catch (error) { throw supplyWriteConflict(error) }
  const ids = productIds ?? [...new Set(invoice.lines.map(row => String(row.product_id)))]
  return readSupplyWriteSnapshot(db, id, tenant, ids)
}
/** Final receipt may be written by the outer receiving transaction after posting. */
export function captureSupplyWriteState(db: LocalDatabase, id: string, tenant: string): () => void {
  const before = readSupplyWriteState(db, id, tenant)
  const productIds = before.products.map(row => row.id)
  return () => {
    if (!isDeepStrictEqual(readSupplyWriteState(db, id, tenant, productIds), before)) throw supplyWriteConflict()
  }
}

export type SupplyWriteState = ReturnType<typeof readSupplyWriteState>
export function assertCleanDraft(state: SupplyWriteState, productIds: string[]) {
  if (state.header.status !== 'draft' || state.movements.length
    || state.products.length !== new Set(productIds).size
    || state.products.some(row => row.tenant_id !== state.header.tenant_id)) throw supplyWriteConflict()
}

/** Cancellation must reverse an intact posted document, never another reversal. */
export function assertPostedSupplyMovements(state: SupplyWriteState) {
  const lineKeys = state.lines.map(row => JSON.stringify([row.product_id, row.qty, row.purchase_price])).sort()
  const movementKeys = state.movements.map(row => JSON.stringify([row.product_id, row.qty_delta, row.unit_cost])).sort()
  if (state.header.status !== 'posted' || !isDeepStrictEqual(lineKeys, movementKeys)
    || state.movements.some(row => row.tenant_id !== state.header.tenant_id || row.deleted_at
      || row.source_type !== 'supply_invoice' || stockQuantity(row.qty_after) !== row.qty_after))
    throw supplyWriteConflict()
}

type SupplyWriteEvent = { operationId: string; type: string; payload: unknown; timestamp: string }

/** Expected changes are computed from the pre-write state, not accepted from storage. */
export function verifySupplyWrite(db: LocalDatabase, expected: SupplyWriteState, event: SupplyWriteEvent, productIds: string[]) {
  const actual = readSupplyWriteState(db, expected.header.id, expected.header.tenant_id, productIds)
  verifySnapshot(db, actual, expected, event, expected.header.id, expected.header.tenant_id)
}

/** Deletion preserves products and history, but leaves no invoice or child rows. */
export function verifyDeletedSupplyWrite(db: LocalDatabase, before: SupplyWriteState, event: SupplyWriteEvent, productIds: string[]) {
  const actual = readSupplyWriteSnapshot(db, before.header.id, before.header.tenant_id, productIds)
  verifySnapshot(db, actual, {...before, header: null, lines: [], payments: []}, event, before.header.id, before.header.tenant_id)
}

function verifySnapshot(db: LocalDatabase, actual: SupplyWriteState, expected: SupplyWriteState, event: SupplyWriteEvent, id: string, tenant: string) {
  const queued = actual.queue.find(row => row.operation_id === event.operationId)
  const expectedEvent = {
    operation_id: event.operationId, tenant_id: tenant, device_id: db.deviceId,
    aggregate_type: 'supply_invoice', aggregate_id: id, operation_type: event.type,
    payload_json: JSON.stringify(event.payload), status: 'pending', attempts: 0,
    next_attempt_at: null, created_at: event.timestamp, synced_at: null, last_error: null,
  }
  if (!queued || !Number.isSafeInteger(queued.sequence) || queued.sequence <= 0
    || Object.entries(expectedEvent).some(([key, value]) => queued[key] !== value)
    || !isDeepStrictEqual({...actual, queue: actual.queue.filter(row => row.operation_id !== event.operationId)}, expected))
    throw supplyWriteConflict()
}
