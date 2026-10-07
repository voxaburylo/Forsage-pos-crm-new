import type { LocalDatabase } from '../db/localDatabase'
import { terminalSupplier, deletedSupplierHistory, sameDeletedSupplierHistory } from './deletedSupplierHistory'
import { readSupplyTerminalReceipt, assertSupplyTerminalRetry, assertUnpaidSupplyTerminal } from './supplyTerminalState'

const quote = (name: string) => '"' + name.replace(/"/g, '""') + '"'
export const supplierMergeReceiptKey = (tenant: string, source: string) => 'supplier-merge:' + tenant + ':' + source
export const supplierMergeHistoryError = () => new Error('До дубліката прив’язані документи або прайси. Злиття з історією потребує окремої звірки; нічого не змінено.')

/** Read-only discovery, including deleted and foreign rows. Never bulk-rewrite history. */
export function assertSupplierHasNoHistory(db: LocalDatabase, tenant: string, source: string, allowed: string[] = [], cancelledIds = new Set<string>(), deletedIds = new Set<string>()) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
  for (const { name } of tables) {
    const columns = db.prepare('PRAGMA table_info(' + quote(name) + ')').all() as { name: string }[]
    const foreignKeys = db.prepare('PRAGMA foreign_key_list(' + quote(name) + ')').all() as { table: string; from: string }[]
    const refs = new Set([...columns.filter(c => c.name === 'supplier_id').map(c => c.name),
      ...foreignKeys.filter(f => f.table === 'suppliers').map(f => f.from)])
    for (const column of refs) if (!(allowed.includes(name) && column === 'supplier_id')
      && db.prepare('SELECT 1 FROM ' + quote(name) + ' WHERE ' + quote(column) + '=? LIMIT 1').get(source))
      throw supplierMergeHistoryError()
  }
  // Deleted drafts retain their original identity outside the invoice table.
  const terminals = db.prepare("SELECT key,value_json FROM app_meta WHERE key LIKE 'supply-terminal:%'").all() as { key: string; value_json: string }[]
  for (const row of terminals) {
    let receipt: any
    try { receipt = JSON.parse(row.value_json) } catch { throw supplierMergeHistoryError() }
    if (!receipt?.payload?.previous_invoice) throw supplierMergeHistoryError()
    if (terminalSupplier(receipt) === source
      && !(((receipt.kind === 'cancelled' && cancelledIds.has(receipt.payload.id))
        || (receipt.kind === 'deleted' && deletedIds.has(receipt.payload.id)))
        && row.key === 'supply-terminal:' + tenant + ':' + receipt.payload.id)) throw supplierMergeHistoryError()
  }
}

const supplierChangeKey = (tenant: string, id: string) => 'invoice-supplier-changes:' + tenant + ':' + id
const isHash = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

export function invoiceSupplierChangeCount(db: LocalDatabase, tenant: string, id: string): number {
  const row = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(supplierChangeKey(tenant,id)) as any
  if (!row) return 0
  let changes: any
  try { changes = JSON.parse(row.value_json) } catch { throw supplierMergeHistoryError() }
  if (!Array.isArray(changes)) throw supplierMergeHistoryError()
  return changes.length
}

/** Internal provenance, committed with an unpaid draft edit, independent of queue cleanup. */
export function recordInvoiceSupplierChange(db: LocalDatabase, tenant: string, before: any, after: any, at: string) {
  if (before.id !== after.id || before.status !== 'draft' || after.status !== 'draft'
    || before.paid_amount !== 0 || after.paid_amount !== 0) throw supplierMergeHistoryError()
  const key = supplierChangeKey(tenant,before.id)
  const old = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(key) as any
  let changes: any[] = []
  if (old) {
    try { changes = JSON.parse(old.value_json) } catch { throw supplierMergeHistoryError() }
    if (!Array.isArray(changes)) throw supplierMergeHistoryError()
  }
  changes.push({ invoice_id: before.id, from: before.supplier_id, to: after.supplier_id,
    before_revision: before.edit_revision, after_revision: after.edit_revision })
  db.prepare('INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at')
    .run(key,JSON.stringify(changes),at)
}

/** Supplier changes require durable evidence: a subsequent merge or an explicit unpaid draft edit. */
function invoiceSupplierReachable(db: LocalDatabase, tenant: string, before: any, target: string, actual: string|null, offset: number): boolean {
  const row = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(supplierChangeKey(tenant,before.id)) as any
  let changes: any[] = []
  if (row && before.status === 'draft' && before.payments.length === 0) {
    try { changes = JSON.parse(row.value_json) } catch { throw supplierMergeHistoryError() }
    if (!Array.isArray(changes) || changes.some(c => c.invoice_id !== before.id || !isHash(c.before_revision)
      || !isHash(c.after_revision) || !(c.from === null || typeof c.from === 'string')
      || !(c.to === null || typeof c.to === 'string'))) throw supplierMergeHistoryError()
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > changes.length) throw supplierMergeHistoryError()
  changes = changes.slice(offset)
  let current: string|null = target, index = 0
  const visited = new Set<string>()
  // Replay provenance in order. A previously visited supplier is not necessarily
  // the final destination: a later edit or merge must also be accounted for.
  while (visited.size < changes.length + 100) {
    const state = JSON.stringify([current,index])
    if (visited.has(state)) throw supplierMergeHistoryError()
    visited.add(state)
    const change = changes[index]
    if (change?.from === current) { current = change.to; index++; continue }
    if (current !== null) {
      const merge = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(supplierMergeReceiptKey(tenant,current)) as any
      if (merge) {
        let parsed: any
        try { parsed = JSON.parse(merge.value_json) } catch { throw supplierMergeHistoryError() }
        const tombstone = db.prepare('SELECT deleted_at,is_active FROM suppliers WHERE tenant_id=? AND id=?').get(tenant,current) as any
        if (parsed.source !== current || typeof parsed.target !== 'string' || parsed.result?.id !== parsed.target
          || parsed.history_payload?.history_version !== 1 || parsed.history_payload?.duplicate_supplier_id !== current
          || parsed.history_payload?.primary_supplier_id !== parsed.target
          || !tombstone?.deleted_at || tombstone.is_active !== 0) throw supplierMergeHistoryError()
        if (!parsed.history_payload?.invoices?.some((i: any) => i.id === before.id)) throw supplierMergeHistoryError()
        current = parsed.target
        continue
      }
      const supplier = db.prepare('SELECT deleted_at FROM suppliers WHERE tenant_id=? AND id=?').get(tenant,current) as any
      if (!supplier || supplier.deleted_at) throw supplierMergeHistoryError()
    }
    return index === changes.length && current === actual
  }
  return false
}

export function readSupplierMergeReceipt(db: LocalDatabase, tenant: string, source: string, target: string, getInvoice: (id: string) => any): any | null {
  const row = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(supplierMergeReceiptKey(tenant, source)) as any
  if (!row) return null
  let receipt: any
  try { receipt = JSON.parse(row.value_json) } catch { throw new Error('Підтвердження злиття пошкоджене. Потрібна звірка.') }
  const tombstone = db.prepare('SELECT deleted_at,is_active FROM suppliers WHERE tenant_id=? AND id=?').get(tenant, source) as any
  if (receipt?.source !== source || receipt.target !== target || receipt.result?.id !== target
    || !tombstone?.deleted_at || tombstone.is_active !== 0)
    throw new Error('Дублікат уже об’єднано з іншою карткою або його стан змінився. Нічого не змінено.')
  const history = receipt.history_payload
  const cancelledIds = new Set<string>()
  if (history) {
    if (history.history_version !== 1 || history.primary_supplier_id !== target || history.duplicate_supplier_id !== source
      || !Array.isArray(history.invoices) || !history.invoices.length) throw supplierMergeHistoryError()
    for (const before of history.invoices) {
      if (!Array.isArray(before.payments) || !['draft','posted','cancelled','deleted'].includes(before.status)) throw supplierMergeHistoryError()
      const current = db.prepare('SELECT * FROM supply_invoices WHERE id=?').get(before.id) as any
      const terminal = readSupplyTerminalReceipt(db,tenant,before.id)
      let destination: string|null
      if (!current) {
        // A deleted draft remains absent; only its durable historical identity moves.
        if (!['draft','deleted'].includes(before.status) || before.payments.length || terminal?.kind !== 'deleted') throw supplierMergeHistoryError()
        const deleted = deletedSupplierHistory(db,tenant,before.id,terminal)
        if (before.status === 'deleted' && !sameDeletedSupplierHistory(before,deleted)) throw supplierMergeHistoryError()
        destination = deleted.snapshot.supplier_id
      } else {
        if (before.status === 'deleted' || current.tenant_id !== tenant || current.deleted_at || !['draft','posted','cancelled'].includes(current.status)
          || (before.status === 'cancelled' && current.status !== 'cancelled')
          || (before.status === 'posted' && current.status === 'draft')) throw supplierMergeHistoryError()
        destination = current.supplier_id
        if (terminal) {
          const invoice = getInvoice(before.id)
          assertUnpaidSupplyTerminal(db,tenant,invoice)
          assertSupplyTerminalRetry(terminal,'cancelled',undefined,invoice)
        }
        if (before.status === 'cancelled') cancelledIds.add(before.id)
      }
      const offset = before.status === 'draft' && !before.payments.length ? receipt.invoice_supplier_change_offsets?.[before.id] ?? 0 : 0
      if (!invoiceSupplierReachable(db,tenant,before,target,destination,offset)) throw supplierMergeHistoryError()
      for (const p of before.payments) {
        const actual = db.prepare('SELECT * FROM supplier_payments WHERE id=?').get(p.id) as any
        if (!actual || actual.tenant_id !== tenant || actual.invoice_id !== before.id || actual.deleted_at
          || actual.supplier_id !== destination || actual.amount !== p.amount || actual.payment_method !== p.payment_method
          || actual.fund_source !== p.fund_source || actual.shift_id !== p.shift_id || actual.note !== p.note
          || actual.created_by !== p.created_by || actual.created_at !== p.created_at) throw supplierMergeHistoryError()
      }
    }
  }
  assertSupplierHasNoHistory(db, tenant, source, [], cancelledIds)
  return receipt.result
}
