import type { LocalDatabase } from '../db/localDatabase'
import { documentRevision } from './documentRevision'
import { normalizeSupplyItem, checkedSupplyMoney } from './supplyValidation'
import { readSupplyTerminalReceipt, type SupplyTerminalReceipt } from './supplyTerminalState'

const conflict = () => new Error('Історія видаленої накладної неузгоджена. Злиття зупинено; нічого не відновлено.')
const validId = (v: unknown): v is string => typeof v === 'string' && !!v.trim()
const date = (v: unknown): string => {
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) throw conflict()
  return new Date(v).toISOString()
}
const nullableText = (v: unknown): string|null => {
  if (v === null || typeof v === 'string') return v
  throw conflict()
}
export function terminalSupplier(receipt: SupplyTerminalReceipt): string|null {
  const original = (receipt.payload.previous_invoice as any)?.supplier_id
  const value = receipt.kind === 'deleted' && receipt.current_supplier_id !== undefined ? receipt.current_supplier_id : original
  if (value !== null && !validId(value)) throw conflict()
  return value
}

/** Deleted local drafts have no invoice row. Their immutable terminal snapshot is
 * the only admissible source; do not reconstruct them from products or prices. */
export function deletedSupplierHistory(db: LocalDatabase, tenant: string, id: string, receipt: SupplyTerminalReceipt) {
  const p = receipt.payload as any, snapshot = p.previous_invoice
  if (receipt.kind !== 'deleted' || p.id !== id || p.previous_status !== 'draft'
    || p.posted_by !== null || p.posted_at !== null || !snapshot
    || db.prepare('SELECT 1 FROM supply_invoices WHERE id=?').get(id)
    || db.prepare('SELECT 1 FROM supply_invoice_items WHERE invoice_id=? LIMIT 1').get(id)
    || db.prepare('SELECT 1 FROM supplier_payments WHERE invoice_id=? LIMIT 1').get(id)) throw conflict()
  const items = snapshot.items
  if (!Array.isArray(items) || !items.length || items.length > 5000
    || new Set(items.map(i=>i.id)).size !== items.length) throw conflict()
  const lines = items.map(line => {
    if (!validId(line.id) || !validId(line.product_id)) throw conflict()
    const normalized = normalizeSupplyItem(line)
    if (!Number.isSafeInteger(line.purchase_price) || !Number.isSafeInteger(line.total)
      || normalized.qty !== line.qty || normalized.purchase_price !== line.purchase_price || normalized.total !== line.total) throw conflict()
    return {id:line.id,product_id:line.product_id,qty:line.qty,purchase_price:line.purchase_price,total:line.total,created_at:date(line.created_at)}
  }).sort((a,b)=>a.id.localeCompare(b.id))
  const total = checkedSupplyMoney(lines.reduce((sum,line)=>sum+line.total,0),'Сума накладної')
  if (total !== snapshot.total) throw conflict()
  const result = {id,status:'deleted' as const,deleted_at:date(p.created_at),posted_by:null,posted_at:null,
    paid_amount:0,payment_method:null,payments:[] as any[],
    snapshot:{supplier_id:terminalSupplier(receipt),invoice_number:nullableText(snapshot.invoice_number),notes:nullableText(snapshot.notes),
      total,created_at:date(snapshot.created_at),items:lines}}
  let current = snapshot.supplier_id as string|null
  if (current !== null && !validId(current)) throw conflict()
  const visited = new Set<string>()
  while (current !== null) {
    if (visited.has(current) || visited.size >= 100) throw conflict()
    visited.add(current)
    const merged=db.prepare('SELECT value_json FROM app_meta WHERE key=?').get('supplier-merge:'+tenant+':'+current) as any
    if (!merged) break
    let proof:any
    try {proof=JSON.parse(merged.value_json)} catch {throw conflict()}
    const old=proof.history_payload?.invoices?.find((i:any)=>i.id===id)
    const source=db.prepare('SELECT deleted_at,is_active FROM suppliers WHERE id=? AND tenant_id=?').get(current,tenant) as any
    if (proof.source!==current || !validId(proof.target) || proof.result?.id!==proof.target
      || proof.history_payload?.history_version!==1 || proof.history_payload?.duplicate_supplier_id!==current
      || proof.history_payload?.primary_supplier_id!==proof.target || !source?.deleted_at || source.is_active!==0
      || old?.status!=='deleted' || old.snapshot?.supplier_id!==current || !sameDeletedSupplierHistory(old,result)) throw conflict()
    current=proof.target
  }
  if (current !== result.snapshot.supplier_id) throw conflict()
  return result
}

export function listDeletedSupplierHistory(db: LocalDatabase, tenant: string, source: string) {
  const prefix = 'supply-terminal:' + tenant + ':'
  const keys = db.prepare('SELECT key FROM app_meta WHERE key LIKE ? ORDER BY key').all(prefix+'%') as {key:string}[]
  return keys.flatMap(row => {
    const id=row.key.slice(prefix.length),receipt=readSupplyTerminalReceipt(db,tenant,id)
    if (!receipt || receipt.kind !== 'deleted') return []
    const history=deletedSupplierHistory(db,tenant,id,receipt)
    return history.snapshot.supplier_id === source ? [history] : []
  })
}
export function moveDeletedSupplierHistory(db: LocalDatabase, tenant: string, id: string, source: string, target: string, at: string) {
  const receipt=readSupplyTerminalReceipt(db,tenant,id)
  if (!receipt || terminalSupplier(receipt)!==source) throw conflict()
  deletedSupplierHistory(db,tenant,id,receipt)
  const next={...receipt,current_supplier_id:target}
  const changed=db.prepare('UPDATE app_meta SET value_json=?,updated_at=? WHERE key=? AND value_json=?')
    .run(JSON.stringify(next),at,'supply-terminal:'+tenant+':'+id,JSON.stringify(receipt))
  if(changed.changes!==1) throw conflict()
}
export function sameDeletedSupplierHistory(before: any, current: any): boolean {
  // The destination can change via a proven merge; no other deleted facts can.
  const identity=(i:any)=>[i.id,i.status,i.deleted_at,i.posted_by,i.posted_at,i.paid_amount,i.payment_method,i.payments,
    i.snapshot.invoice_number,i.snapshot.notes,i.snapshot.total,i.snapshot.created_at,
    [...i.snapshot.items].sort((a:any,b:any)=>a.id.localeCompare(b.id)).map((l:any)=>[l.id,l.product_id,l.qty,l.purchase_price,l.total,l.created_at])]
  return documentRevision(identity(before))===documentRevision(identity(current))
}
