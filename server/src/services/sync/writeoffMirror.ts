import { z } from 'zod'
import { runTransaction } from '../../db/pg.js'
import { AppError } from '../../middleware/errorHandler.js'
import { isUuid, type SyncOutboxOperation } from './syncCore.js'

const id=z.string().refine(isUuid).transform(value=>value.toLowerCase())
const timestamp=z.string().refine(value=>Number.isFinite(Date.parse(value))).transform(value=>new Date(value).toISOString())
const money=z.number().int().nonnegative().max(2147483647)
const quantity=z.number().finite().positive().max(999999999.999)
 .refine(value=>Math.abs(value*1000-Math.round(value*1000))<0.000001)
const copySchema=z.object({
 id,reason:z.enum(['damage','expiry','loss','audit','other']),notes:z.string().nullable(),
 created_by:id,created_at:timestamp,
 items:z.array(z.object({id,product_id:id,qty:quantity,cost_kopecks:money,created_at:timestamp})).min(1).max(5000),
})
const iso=(value:unknown)=>new Date(value as string).toISOString()
function invalid():never {
 throw new AppError('SYNC_WRITEOFF_COPY_REQUIRED','Копія списання потребує точних рядків, початкової вартості, автора й дати з локального акта. Оновіть локальну програму та повторіть передачу.',422)
}
function conflict():never {
 throw new AppError('SYNC_WRITEOFF_COPY_CONFLICT','Серверна копія списання відрізняється від локального акта. Потрібна звірка; залишки повторно не змінено.',409)
}
/** The act has already consumed stock locally. Only copy its immutable document.
 * Never recalculate cost from today's product card, or replay a stock delta. */
export async function applyWriteoffCreated(tenantId:string,_userId:string,operation:SyncOutboxOperation):Promise<void> {
 if(operation.tenant_id!==tenantId)invalid()
 const payload=operation.payload??{}
 const parsed=copySchema.safeParse({...payload,id:payload.id??operation.aggregate_id})
 if(!parsed.success)invalid()
 const copy=parsed.data
 if(copy.id!==operation.aggregate_id.toLowerCase()
  || new Set(copy.items.map(row=>row.id)).size!==copy.items.length
  || new Set(copy.items.map(row=>row.product_id)).size!==copy.items.length
  || copy.items.reduce((total,row)=>total+row.cost_kopecks,0)>2147483647)invalid()
 const header=[copy.id,tenantId,copy.reason,copy.notes,copy.created_by,copy.created_at]
 const lines=copy.items.map(row=>[row.id,row.product_id,row.qty,row.cost_kopecks,row.created_at])
  .sort((a,b)=>String(a[0]).localeCompare(String(b[0])))
 await runTransaction(async client=>{
  await client.query("SELECT set_config('app.sync_mode','true',true)")
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['writeoff-copy:'+copy.id])
  const existing=(await client.query('SELECT * FROM inventory_writeoffs WHERE id=$1 FOR UPDATE',[copy.id])).rows[0]
  if(existing){
   const saved=[existing.id,existing.tenant_id,existing.reason,existing.notes,existing.created_by,iso(existing.created_at)]
   if(existing.deleted_at||JSON.stringify(saved)!==JSON.stringify(header))conflict()
   const rows=(await client.query('SELECT * FROM inventory_writeoff_items WHERE writeoff_id=$1 ORDER BY id',[copy.id])).rows
   const stored=rows.map(row=>[row.id,row.product_id,Number(row.qty),Number(row.cost_kopecks),iso(row.created_at)])
   if(rows.some(row=>row.deleted_at)||JSON.stringify(stored)!==JSON.stringify(lines))conflict()
   return
  }
  const products=await client.query('SELECT id FROM products WHERE tenant_id=$1 AND id=ANY($2::uuid[]) FOR KEY SHARE',
   [tenantId,copy.items.map(row=>row.product_id)])
  if(products.rowCount!==copy.items.length)throw new AppError('SYNC_PRODUCT_NOT_FOUND','Спочатку передайте картки товарів цього акта списання.',409)
  const reused=await client.query('SELECT id FROM inventory_writeoff_items WHERE id=ANY($1::uuid[])',[copy.items.map(row=>row.id)])
  if(reused.rowCount)conflict()
  await client.query(
   'INSERT INTO inventory_writeoffs(id,tenant_id,reason,notes,created_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
   [...header,operation.applied_at??operation.created_at])
  for(const row of copy.items)await client.query(
   'INSERT INTO inventory_writeoff_items(id,writeoff_id,product_id,qty,cost_kopecks,created_at) VALUES($1,$2,$3,$4,$5,$6)',
   [row.id,copy.id,row.product_id,row.qty,row.cost_kopecks,row.created_at])
 })
}
