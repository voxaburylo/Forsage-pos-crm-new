import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { runTransaction } from '../../db/pg.js'
import { AppError } from '../../middleware/errorHandler.js'
import { normalizeOemValue } from '../../validators/productValidator.js'
import type { SyncOutboxOperation } from './syncCore.js'
import { assertProductReferenceExists } from './syncGuards.js'
export { preserveCleanupSpecs } from '../catalogCleanupGuards.js'

const id = z.string().uuid().transform(v => v.toLowerCase())
const date = z.string().refine(v => Number.isFinite(Date.parse(v)))
const record = z.record(z.unknown())
const common = { id, tenant_id:id, product_id:id, created_at:date, updated_at:date, deleted_at:date.nullable().optional() }
const schema = z.object({
  version:z.literal(1),operation_id:id,target_id:id,source_ids:z.array(id).min(1).max(20),
  stock_review:z.enum(['pending','checked']),reason:z.string().trim().min(1).max(2000),user_id:id,merged_at:date,
  products:z.array(z.object({id,tenant_id:id,sku:z.string().min(1).max(100),name:z.string().min(1).max(1000),
    barcode:z.string().max(100).nullable().optional(),brand_id:id.nullable().optional(),specs:record,
    qty_on_hand:z.number().finite(),deleted_at:date.nullable().optional(),is_active:z.boolean(),
  }).passthrough()).min(2).max(21),
  barcodes:z.array(z.object({...common,barcode:z.string().trim().min(1).max(100),barcode_type:z.string().max(20).optional(),is_primary:z.union([z.boolean(),z.literal(0),z.literal(1)])})).max(5000),
  aliases:z.array(z.object({...common,alias:z.string().min(1).max(300)})).max(5000),
  cross_numbers:z.array(z.object({...common,cross_number:z.string().trim().min(1).max(100),brand:z.string().max(100).nullable().optional(),source:z.string().max(200).optional(),notes:z.string().nullable().optional()})).max(5000),
})
function invalid():never { throw new AppError('SYNC_CATALOG_CLEANUP_INVALID','Неповна або непідтверджена копія злиття номенклатури',422) }
function conflict():never { throw new AppError('SYNC_CATALOG_CLEANUP_CONFLICT','Дані карток або метадані змінилися; злиття не скопійовано. Потрібна перевірка черги.',409) }
function object(value:unknown):Record<string,any> { return value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,any> : {} }
function historyBarcodes(value:unknown):string[] {
  if(value===undefined) return []
  const parsed=z.array(z.string().min(1).max(100)).max(5000).safeParse(value)
  if(!parsed.success)invalid()
  return parsed.data
}
const stable = (v:any):any => Array.isArray(v) ? v.map(stable) : v && typeof v==='object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])) : v
const hash = (v:unknown) => createHash('sha256').update(JSON.stringify(stable(v))).digest('hex')

/** All sync catalog writers share this lock before taking product row locks. */
export async function lockCatalogMirror(client:PoolClient,tenant:string):Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['catalog:'+tenant])
}
export function staleCleanupCatalogWrite(existing:unknown,payload:any,operation?:Pick<SyncOutboxOperation,'device_id'|'sequence'>):boolean {
  const specs=object(existing)
  if(specs.merged_into_product_id) return true
  if(!specs.cleanup_mirrored_at) return false
  // Local outbox order survives delayed delivery and works for legacy product
  // edits/deletes that have no payload.updated_at. Arrival time does not.
  if(operation) {
    const receipts=Object.values(object(specs.cleanup_mirror_receipts)).filter((r:any)=>r?.device_id===operation.device_id&&Number.isSafeInteger(r?.sequence))
    if(receipts.length) return operation.sequence<=Math.max(...receipts.map((r:any)=>r.sequence))
  }
  const localTime=Date.parse(payload?.updated_at ?? payload?.deleted_at ?? '')
  // Other device/legacy payloads cannot prove a newer edit without source time.
  return !Number.isFinite(localTime) || localTime<=Date.parse(specs.cleanup_mirrored_at)
}

/** Copies metadata only. Stock comes exclusively from an independently signed current snapshot. */
export async function applyCatalogCleanupMirror(tenant:string,operation:SyncOutboxOperation):Promise<void> {
  const parsed=schema.safeParse(operation.payload)
  if(!parsed.success || !operation.balance_mirrored || operation.operation_type!=='product.catalog_cleanup'
    || operation.tenant_id!==tenant || !id.safeParse(operation.operation_id).success
    || Buffer.byteLength(JSON.stringify(operation.payload),'utf8')>2_000_000) invalid()
  const p=parsed.data,ids=[p.target_id,...p.source_ids].sort(),allowed=new Set(ids)
  if(operation.aggregate_id.toLowerCase()!==p.target_id || new Set(ids).size!==ids.length
    || p.products.length!==ids.length || new Set(p.products.map(r=>r.id)).size!==ids.length
    || p.products.some(r=>!allowed.has(r.id)||r.tenant_id!==tenant))invalid()
  const targetCopy=p.products.find(r=>r.id===p.target_id)!,sourceCopies=p.products.filter(r=>r.id!==p.target_id)
  const provenance=object(targetCopy.specs).cleanup_sources
  const additions=Array.isArray(provenance)?provenance.filter((r:any)=>r?.merge_operation_id===p.operation_id):[]
  if(targetCopy.deleted_at || !targetCopy.is_active || targetCopy.specs.merged_into_product_id
    || additions.length!==p.source_ids.length || new Set(additions.map((r:any)=>r?.id)).size!==p.source_ids.length
    || additions.some((r:any)=>!p.source_ids.includes(r?.id))
    || sourceCopies.some(r=>!r.deleted_at||r.is_active||r.qty_on_hand!==0||r.specs.merged_into_product_id!==p.target_id||r.specs.merge_operation_id!==p.operation_id))invalid()
  for(const list of [p.barcodes,p.aliases,p.cross_numbers]) if(new Set(list.map(r=>r.id)).size!==list.length
    || list.some(r=>r.tenant_id!==tenant||!allowed.has(r.product_id)))invalid()
  if([...p.barcodes,...p.aliases].some(r=>!r.deleted_at&&r.product_id!==p.target_id)
    || p.cross_numbers.some(r=>!r.deleted_at&&r.product_id!==p.target_id&&!p.cross_numbers.some(c=>!c.deleted_at&&c.product_id===p.target_id&&normalizeOemValue(c.cross_number)===normalizeOemValue(r.cross_number))))invalid()
  const barcodeKeys=p.barcodes.filter(r=>!r.deleted_at).map(r=>r.barcode)
  const crossKeys=p.cross_numbers.filter(r=>!r.deleted_at).map(r=>r.product_id+':'+normalizeOemValue(r.cross_number))
  if(new Set(barcodeKeys).size!==barcodeKeys.length
    || new Set(crossKeys).size!==crossKeys.length
    || p.barcodes.filter(r=>!r.deleted_at&&Boolean(r.is_primary)).length>1
    || p.products.some(r=>r.barcode&&!barcodeKeys.includes(r.barcode))
    || p.cross_numbers.some(r=>!normalizeOemValue(r.cross_number)))invalid()
  const fingerprint=hash(p),receipt={operation_id:operation.operation_id.toLowerCase(),device_id:operation.device_id,sequence:operation.sequence,
    payload_hash:fingerprint,target_id:p.target_id,source_ids:p.source_ids,
    // The server cross-number schema has no notes column. Retain local annotations as provenance.
    cross_notes:p.cross_numbers.filter(r=>r.notes).map(r=>({id:r.id,number:r.cross_number,notes:r.notes}))}
  await runTransaction(async client=>{
    await lockCatalogMirror(client,tenant)
    const rows=(await client.query('SELECT * FROM products WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[tenant,ids])).rows
    if(rows.length!==ids.length)conflict()
    const target=rows.find(r=>r.id===p.target_id)!,sources=rows.filter(r=>r.id!==p.target_id),targetSpecs=object(target.specs)
    const receipts=object(targetSpecs.cleanup_mirror_receipts),previous=receipts[p.operation_id]
    if(previous) {
      if(hash(previous)!==hash(receipt)||sources.some(r=>!r.deleted_at||r.is_active||object(r.specs).merged_into_product_id!==p.target_id||object(r.specs).merge_operation_id!==p.operation_id))conflict()
      return
    }
    if(target.deleted_at||!target.is_active||targetSpecs.merged_into_product_id
      || sources.some(r=>r.deleted_at||!r.is_active||object(r.specs).merged_into_product_id)
      || rows.some(r=>r.sku!==p.products.find(item=>item.id===r.id)!.sku
        || (r.barcode??null)!==(p.products.find(item=>item.id===r.id)!.barcode??null)))conflict()
    const balances=(await client.query("SELECT entity_id,balances FROM local_balance_mirror WHERE tenant_id=$1 AND entity_type='product' AND entity_id=ANY($2::uuid[])",[tenant,ids])).rows
    if(balances.length!==ids.length || sources.some(r=>Number(r.qty_on_hand)!==0||Number(balances.find(b=>b.entity_id===r.id)?.balances?.qty_on_hand)!==0))conflict()
    if((await client.query('SELECT id FROM products WHERE tenant_id=$1 AND NOT(id=ANY($2::uuid[])) AND sku=ANY($3::text[]) LIMIT 1',[tenant,ids,p.products.map(r=>r.sku)])).rowCount)conflict()
    if((await client.query(`SELECT id FROM products WHERE tenant_id=$1 AND NOT(id=ANY($2::uuid[])) AND deleted_at IS NULL
      AND (barcode=ANY($3::text[]) OR additional_barcodes ?| $3::text[]) LIMIT 1`,[tenant,ids,barcodeKeys])).rowCount)conflict()
    // Primary IDs must not reassign foreign tenants or unrelated catalog cards.
    for(const [table,list] of [['product_barcodes',p.barcodes],['product_aliases',p.aliases],['product_cross_numbers',p.cross_numbers]] as const) {
      const byId=(await client.query(`SELECT id,tenant_id,product_id FROM ${table} WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,[list.map(r=>r.id)])).rows
      if(byId.some(r=>r.tenant_id!==tenant||!allowed.has(r.product_id)))conflict()
    }
    const existingCodes=(await client.query('SELECT * FROM product_barcodes WHERE tenant_id=$1 AND (product_id=ANY($2::uuid[]) OR barcode=ANY($3::text[])) ORDER BY id FOR UPDATE',[tenant,ids,barcodeKeys])).rows
    if(existingCodes.some(r=>!r.deleted_at&&(!allowed.has(r.product_id)||!barcodeKeys.includes(r.barcode))))conflict()
    const sourceHistory=new Map<string,string[]>()
    for(const row of sources) {
      const provided=historyBarcodes(sourceCopies.find(r=>r.id===row.id)!.specs.cleanup_barcodes)
      const prior=historyBarcodes(object(row.specs).cleanup_barcodes)
      const original=historyBarcodes(object(additions.find((r:any)=>r.id===row.id)?.specs).cleanup_barcodes)
      if(provided.some(code=>!barcodeKeys.includes(code)&&!prior.includes(code)&&!original.includes(code)))invalid()
      sourceHistory.set(row.id,[...new Set([...provided,...prior,...original,row.barcode,
        ...existingCodes.filter(code=>code.product_id===row.id&&!code.deleted_at).map(code=>code.barcode)].filter((code):code is string=>typeof code==='string'&&Boolean(code)))])
    }
    // Preserve all annotations; source aliases/crosses not represented in the local manifest need review.
    const existingAliases=(await client.query('SELECT * FROM product_aliases WHERE tenant_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[tenant,ids])).rows
    if(existingAliases.some(r=>!r.deleted_at&&!p.aliases.some(a=>!a.deleted_at&&a.alias===r.alias))
      || p.aliases.some(a=>existingAliases.some(r=>r.id===a.id&&r.alias!==a.alias)))conflict()
    const existingCross=(await client.query('SELECT * FROM product_cross_numbers WHERE tenant_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[tenant,ids])).rows
    if(existingCross.some(r=>!r.deleted_at&&!p.cross_numbers.some(c=>!c.deleted_at&&normalizeOemValue(c.cross_number)===r.normalized_number)))conflict()
    const brand=target.brand_id??targetCopy.brand_id??null
    await assertProductReferenceExists(client,tenant,'brands',brand,'Бренд')
    for(const row of p.barcodes.filter(r=>!r.deleted_at)) {
      const current=existingCodes.find(r=>r.barcode===row.barcode)
      if(current&&!allowed.has(current.product_id))conflict()
      await client.query(`INSERT INTO product_barcodes(id,tenant_id,product_id,barcode,barcode_type,is_primary,created_at,updated_at,deleted_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL) ON CONFLICT(tenant_id,barcode) DO UPDATE SET product_id=EXCLUDED.product_id,
        is_primary=EXCLUDED.is_primary,updated_at=EXCLUDED.updated_at,deleted_at=NULL`,
        [current?.id??row.id,tenant,p.target_id,row.barcode,row.barcode_type??'ean13',Boolean(row.is_primary),row.created_at,operation.applied_at??operation.created_at])
    }
    for(const row of p.aliases.filter(r=>!r.deleted_at)) {
      const current=existingAliases.find(r=>r.id===row.id)??existingAliases.find(r=>r.alias===row.alias&&!r.deleted_at)
      if(current) await client.query('UPDATE product_aliases SET product_id=$3,updated_at=$4,deleted_at=NULL WHERE tenant_id=$1 AND id=$2',[tenant,current.id,p.target_id,operation.applied_at??operation.created_at])
      else await client.query('INSERT INTO product_aliases(id,tenant_id,product_id,alias,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6)',[row.id,tenant,p.target_id,row.alias,row.created_at,operation.applied_at??operation.created_at])
    }
    for(const row of p.cross_numbers.filter(r=>!r.deleted_at)) {
      const normalized=normalizeOemValue(row.cross_number)
      const current=existingCross.find(r=>r.id===row.id)??existingCross.find(r=>r.product_id===row.product_id&&r.normalized_number===normalized)
      if(current&&current.normalized_number!==normalized)conflict()
      // A conflicting normalized key is not silently overwritten or reassigned.
      const sameTarget=existingCross.filter(r=>r.product_id===row.product_id&&r.normalized_number===normalized&&r.id!==current?.id)
      if(sameTarget.length)conflict()
      if(current) await client.query('UPDATE product_cross_numbers SET product_id=$3,updated_at=$4,deleted_at=NULL WHERE tenant_id=$1 AND id=$2',[tenant,current.id,row.product_id,operation.applied_at??operation.created_at])
      else await client.query(`INSERT INTO product_cross_numbers(id,tenant_id,product_id,number,normalized_number,number_type,brand,source,is_verified,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'cross',$6,$7,false,$8,$9)`,[row.id||randomUUID(),tenant,row.product_id,row.cross_number,normalized,row.brand??null,row.source??'manual',row.created_at,operation.applied_at??operation.created_at])
    }
    const mergedSources=[...(Array.isArray(targetSpecs.cleanup_sources)?targetSpecs.cleanup_sources:[]),...additions]
    const specs={...targetSpecs,cleanup_sources:mergedSources,cleanup_stock_review:{status:p.stock_review,user_id:p.user_id,at:p.merged_at,operation_id:p.operation_id},
      cleanup_mirror_receipts:{...receipts,[p.operation_id]:receipt},cleanup_mirrored_at:p.merged_at}
    await client.query(`UPDATE products SET specs=$3,brand_id=$4,additional_barcodes=$5::jsonb,updated_at=$6 WHERE tenant_id=$1 AND id=$2`,
      [tenant,p.target_id,JSON.stringify(specs),brand,JSON.stringify(barcodeKeys.filter(code=>code!==target.barcode)),operation.applied_at??operation.created_at])
    for(const row of sources) await client.query('UPDATE products SET specs=$3,is_active=false,deleted_at=$4,updated_at=$5 WHERE tenant_id=$1 AND id=$2',
      [tenant,row.id,JSON.stringify({...object(row.specs),cleanup_barcodes:sourceHistory.get(row.id),merged_into_product_id:p.target_id,merge_operation_id:p.operation_id}),p.merged_at,operation.applied_at??operation.created_at])
  })
}
