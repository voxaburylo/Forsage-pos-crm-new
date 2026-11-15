import { isDeepStrictEqual } from 'node:util'
import type { LocalDatabase } from '../db/localDatabase'
import { catalogQuantity, catalogPriceKopecks } from '../lib/supplierCatalogNumbers'
import { catalogTimestamp } from './supplierCatalogRemoteValidation'
import { normalizeLocalSupplierSku, normalizeLocalSupplierBarcode, normalizeLocalSupplierName } from './supplierCatalogRepository'
import { catalogMergeError, readCatalogSupplierChanges } from './supplierCatalogSupplierChanges'

type Row = Record<string, any>
const tables = ['supplier_price_items','supplier_price_imports'] as const
type Table = typeof tables[number]
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v)
const date = (v: unknown) => new Date(catalogTimestamp(v)).toISOString()
const nullableText = (v: unknown): string | null => {
  if (v !== null && typeof v !== 'string') throw catalogMergeError()
  return v as string | null
}
const requiredText = (v: unknown): string => {
  if (typeof v !== 'string' || !v.trim()) throw catalogMergeError()
  return v
}
function view(table: Table, row: Row): Row {
  if (!uuid(row.id)) throw catalogMergeError()
  const base = {id:row.id, warehouse_name:nullableText(row.warehouse_name),
    created_at:date(row.created_at), deleted_at:row.deleted_at === null ? null : date(row.deleted_at)}
  if (table === 'supplier_price_items') return {...base, sku:requiredText(row.sku),
    barcode:nullableText(row.barcode),brand:nullableText(row.brand),name:requiredText(row.name),
    price_kopecks:catalogPriceKopecks(row.price_kopecks),qty:catalogQuantity(row.qty)}
  let errors: any
  try { errors = JSON.parse(row.errors_json) } catch { throw catalogMergeError() }
  if (!Array.isArray(errors) || errors.some(e => !e || typeof e !== 'object' || Array.isArray(e)
    || Object.keys(e).some(k => !['row','error','raw'].includes(k))
    || !Number.isSafeInteger(e.row) || e.row < 0 || typeof e.error !== 'string'
    || (e.raw !== undefined && typeof e.raw !== 'string'))
    || !['completed','failed'].includes(row.status) || ![0,1].includes(row.scope_known)
    || !['add','replace'].includes(row.mode)
    || !Number.isInteger(row.total_rows) || row.total_rows < 0 || row.total_rows > 2147483647
    || !Number.isInteger(row.processed_rows) || row.processed_rows < 0 || row.processed_rows > row.total_rows)
    throw catalogMergeError()
  return {...base,mode:row.scope_known === 1 ? row.mode : null,
    filename:requiredText(row.filename),status:row.status,
    total_rows:row.total_rows,processed_rows:row.processed_rows,errors_log:errors}
}
export type LocalCatalogMerge = {version:1; items:Row[]; imports:Row[]}
const totalChanges = (db:LocalDatabase) => Number((db.prepare('SELECT total_changes() n').get() as any).n)
const sorted = (rows:Row[]) => [...rows].sort((a,b)=>a.id.localeCompare(b.id))

/** No writes before full validation. Caller owns BEGIN IMMEDIATE through receipt/outbox. */
export function prepareSupplierCatalogHistory(db:LocalDatabase,tenant:string,source:string,target:string) {
  const captures = tables.map(table => ({
    table, rows:db.prepare('SELECT * FROM '+table+' WHERE supplier_id=? ORDER BY id LIMIT 10001').all(source) as Row[],
    target:db.prepare('SELECT * FROM '+table+' WHERE supplier_id=? ORDER BY id LIMIT 10001').all(target) as Row[],
  }))
  if (captures.every(c => !c.rows.length)) return null
  if (!uuid(source) || !uuid(target) || source === target) throw catalogMergeError()
  const payload:LocalCatalogMerge = {version:1,items:[],imports:[]}
  for (const capture of captures) {
    if (capture.rows.length > (capture.table === 'supplier_price_items' ? 5000 : 1000)
      || capture.target.length > 10000 || [...capture.rows,...capture.target].some(r=>r.tenant_id!==tenant)) throw catalogMergeError()
    const rows = capture.rows.map(row => view(capture.table,row))
    for (const row of capture.target) view(capture.table,row)
    if (capture.table === 'supplier_price_items') payload.items=rows
    else payload.imports=rows
  }
  const active = [...captures[0].rows,...captures[0].target].filter(row=>!row.deleted_at)
  if (active.length>10000) throw catalogMergeError()
  const identities = new Set<string>()
  for (const row of active) {
    for (const [field,normalized] of [
      ['sku',normalizeLocalSupplierSku(row.sku)], ['barcode',normalizeLocalSupplierBarcode(row.barcode)],
      ['name',normalizeLocalSupplierName(row.name)],
    ]) {
      if (!normalized) continue
      const key=JSON.stringify([row.warehouse_name,field,normalized])
      if (identities.has(key)) throw new Error('У прайсах є однаковий артикул, штрихкод або назва в одному складі. Спочатку звірте ці позиції; нічого не змінено.')
      identities.add(key)
    }
  }
  const offsets=Object.fromEntries(payload.items.map(row=>[row.id,readCatalogSupplierChanges(db,tenant,row.id).length]))
  return {payload,offsets,apply(timestamp:string) {
    const before = totalChanges(db)
    for (const capture of captures) {
      const result=db.prepare('UPDATE '+capture.table+' SET supplier_id=?,dirty_at=?,updated_at=? WHERE tenant_id=? AND supplier_id=?')
        .run(target,timestamp,timestamp,tenant,source)
      if (result.changes!==capture.rows.length) throw catalogMergeError()
    }
    if (totalChanges(db)-before!==captures.reduce((n,c)=>n+c.rows.length,0)) throw catalogMergeError()
    const verify=()=>{
      for (const capture of captures) {
        if (db.prepare('SELECT 1 FROM '+capture.table+' WHERE supplier_id=? LIMIT 1').get(source)) throw catalogMergeError()
        const expected=sorted([...capture.target,...capture.rows.map(row=>({...row,supplier_id:target,dirty_at:timestamp,updated_at:timestamp}))])
        const actual=db.prepare('SELECT * FROM '+capture.table+' WHERE supplier_id=? ORDER BY id').all(target)
        if (!isDeepStrictEqual(actual.map(row=>({...row})),expected.map(row=>({...row})))) throw catalogMergeError()
      }
    }
    verify()
    return verify
  }}
}

/** Follow only durable explicit edits and recorded merges containing the same ID. */
export function verifySupplierCatalogHistoryRetry(db:LocalDatabase,tenant:string,target:string,copy:LocalCatalogMerge,
  offsets:Record<string,number> = {}) {
  if (copy.version!==1 || !Array.isArray(copy.items) || !Array.isArray(copy.imports)
    || copy.items.length>5000 || copy.imports.length>1000 || (!copy.items.length && !copy.imports.length)) throw catalogMergeError()
  const mergeCache = new Map<string,{target:string;items:Set<string>;imports:Set<string>}|null>()
  const nextMerge=(supplier:string)=>{
    if (mergeCache.has(supplier)) return mergeCache.get(supplier)!
    const parent=db.prepare('SELECT deleted_at,is_active FROM suppliers WHERE tenant_id=? AND id=?').get(tenant,supplier) as any
    const raw=db.prepare('SELECT value_json FROM app_meta WHERE key=?').get('supplier-merge:'+tenant+':'+supplier) as any
    if (!parent) throw catalogMergeError()
    if (!raw) {
      if (parent.deleted_at) throw catalogMergeError()
      mergeCache.set(supplier,null); return null
    }
    let receipt:any
    try {receipt=JSON.parse(raw.value_json)} catch {throw catalogMergeError()}
    const history=receipt.history_payload, catalog=history?.catalog
    if (!parent.deleted_at || parent.is_active!==0 || receipt.source!==supplier || !uuid(receipt.target)
      || receipt.result?.id!==receipt.target || history?.history_version!==1
      || history.duplicate_supplier_id!==supplier || history.primary_supplier_id!==receipt.target
      || catalog?.version!==1 || !Array.isArray(catalog.items) || !Array.isArray(catalog.imports)) throw catalogMergeError()
    const next={target:receipt.target,items:new Set<string>(catalog.items.map((r:any)=>r.id)),imports:new Set<string>(catalog.imports.map((r:any)=>r.id))}
    mergeCache.set(supplier,next);return next
  }
  for (const table of tables) {
    const original=table==='supplier_price_items'?copy.items:copy.imports
    const ids=original.map(row=>row.id)
    if (new Set(ids).size!==ids.length || ids.some(id=>!uuid(id))) throw catalogMergeError()
    const rows=db.prepare('SELECT id,tenant_id,supplier_id FROM '+table+' WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as Row[]
    if (rows.length!==ids.length || rows.some(row=>row.tenant_id!==tenant)) throw catalogMergeError()
    for (const row of rows) {
      const changes=table==='supplier_price_items'?readCatalogSupplierChanges(db,tenant,row.id):[]
      const offset=table==='supplier_price_items'?offsets[row.id]??0:0
      if (!Number.isSafeInteger(offset)||offset<0||offset>changes.length) throw catalogMergeError()
      let current:string|null=target,index=offset
      const visited=new Set<string>()
      while (true) {
        const state=JSON.stringify([current,index])
        if (visited.has(state)||visited.size>changes.length+100) throw catalogMergeError()
        visited.add(state)
        if (changes[index]?.from===current) { current=changes[index].to;index++;continue }
        const next=current===null?null:nextMerge(current)
        if (next) {
          if (!(table==='supplier_price_items'?next.items:next.imports).has(row.id)) throw catalogMergeError()
          current=next.target;continue
        }
        if (index!==changes.length||current!==row.supplier_id) throw catalogMergeError()
        break
      }
    }
  }
}
