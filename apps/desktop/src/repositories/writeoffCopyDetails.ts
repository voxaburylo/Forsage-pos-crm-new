import type { LocalDatabase } from '../db/localDatabase'
import type { LocalSyncOutboxOperation } from '../db/localTypes'

/** Read missing provenance from the identical local act. Never guess today's
 * cost, change a queued decision, or modify the saved queue/document. */
export function attachWriteoffCopyDetails(db:LocalDatabase,operation:LocalSyncOutboxOperation,payload:Record<string,any>):void {
 if(operation.operation_type!=='writeoff.created')return
 if(payload.id!==undefined&&payload.id!==operation.aggregate_id)return
 const stored=db.prepare(`SELECT id,reason,notes,created_by,created_at FROM writeoffs
  WHERE id=? AND tenant_id=? AND deleted_at IS NULL`).get(operation.aggregate_id,operation.tenant_id) as Record<string,any>|undefined
 if(!stored||!Array.isArray(payload.items)||payload.items.length===0)return
 for(const key of ['reason','notes','created_by','created_at'])if(payload[key]!==undefined&&payload[key]!==stored[key])return
 const rows=db.prepare(`SELECT id,product_id,qty,cost_kopecks,created_at FROM writeoff_items
  WHERE writeoff_id=? AND tenant_id=? AND deleted_at IS NULL ORDER BY id`).all(operation.aggregate_id,operation.tenant_id) as Record<string,any>[]
 if(rows.length!==payload.items.length)return
 const byProduct=new Map(rows.map(row=>[row.product_id,row]))
 if(byProduct.size!==rows.length||new Set(payload.items.map((row:any)=>row?.product_id)).size!==rows.length)return
 for(const item of payload.items){
  const row=byProduct.get(item?.product_id)
  if(!row||typeof item.qty!=='number'||item.qty!==row.qty)return
  for(const key of ['id','cost_kopecks','created_at'])if(item[key]!==undefined&&item[key]!==row[key])return
 }
 for(const key of ['id','reason','notes','created_by','created_at'])if(payload[key]===undefined)payload[key]=stored[key]
 payload.items=payload.items.map((item:Record<string,any>)=>{
  const copy={...item},row=byProduct.get(item.product_id)!
  for(const key of ['id','cost_kopecks','created_at'])if(copy[key]===undefined)copy[key]=row[key]
  return copy
 })
}
