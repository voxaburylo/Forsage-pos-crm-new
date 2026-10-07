import { randomUUID } from 'node:crypto'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach,beforeEach,describe,it,expect } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalWarehouseRepository } from '../src/repositories/warehouseRepository'
import { attachBalanceSnapshots } from '../src/repositories/balanceSnapshot'

describe('writeoff source copy and read-only legacy enrichment',()=>{
 let root:string,db:LocalDatabase,warehouse:LocalWarehouseRepository,product:string,actor:string
 beforeEach(()=>{
  root=mkdtempSync(path.join(tmpdir(),'forsage-writeoff-copy-'));db=new LocalDatabase(root);warehouse=new LocalWarehouseRepository(db)
  actor=randomUUID();product=randomUUID()
  new LocalCatalogRepository(db).upsertProduct({id:product,name:'Олива',sku:randomUUID(),purchase_price:123,qty_on_hand:10})
 })
 afterEach(()=>{db.close();if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-writeoff-copy-'))rmSync(root,{recursive:true,force:true})})
 function copy(){
  const document=warehouse.createWriteoff({reason:'damage',notes:'Тест',user_id:actor,operation_id:randomUUID(),items:[{product_id:product,qty:1.5}]})
  const row=db.prepare("SELECT * FROM sync_outbox WHERE aggregate_id=? AND operation_type='writeoff.created'").get(document.id) as any
  return {document,operation:{...row,payload:JSON.parse(row.payload_json)}}
 }
 function legacy(){
  const result=copy(),p=result.operation.payload
  delete p.created_by;delete p.created_at
  for(const row of p.items){delete row.id;delete row.cost_kopecks;delete row.created_at}
  return result
 }
 it('queues exact stored line IDs, historical cost, actor and original date',()=>{
  const {document,operation}=copy()
  expect(operation.payload).toMatchObject({id:document.id,created_by:actor,created_at:document.created_at,
   items:[{id:document.items[0].id,product_id:product,qty:1.5,cost_kopecks:185,created_at:document.created_at}]})
  expect(db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get(product)).toMatchObject({qty_on_hand:8.5})
 })
 it('recovers omitted old fields from the act after restart, without touching stock, queue or source objects',()=>{
  const {document,operation}=legacy()
  db.prepare('UPDATE products SET purchase_price=999,qty_on_hand=0 WHERE id=?').run(product)
  db.close();db=new LocalDatabase(root)
  const before=JSON.stringify(operation),queue=db.prepare('SELECT * FROM sync_outbox').all()
  const items=db.prepare('SELECT * FROM writeoff_items').all()
  db.exec('PRAGMA query_only=ON')
  try{
   const result=attachBalanceSnapshots(db,[operation])[0].payload
   expect(result).toMatchObject({created_by:actor,created_at:document.created_at,
    items:[{id:document.items[0].id,qty:1.5,cost_kopecks:185,created_at:document.created_at}]})
   expect(result.local_balance_snapshot.products[0].qty_on_hand).toBe(0)
   expect(JSON.stringify(operation)).toBe(before)
   expect(db.prepare('SELECT * FROM sync_outbox').all()).toEqual(queue)
   expect(db.prepare('SELECT * FROM writeoff_items').all()).toEqual(items)
  }finally{db.exec('PRAGMA query_only=OFF')}
 })
 it.each(['tenant','id','reason','notes','actor','date','qty','missing line','extra line','deleted header','deleted line','line id','cost','line date'])('does not enrich mismatched %s',kind=>{
  const {operation}=legacy(),p=operation.payload
  if(kind==='tenant')operation.tenant_id=randomUUID()
  if(kind==='id')p.id=randomUUID()
  if(kind==='reason')p.reason='loss'
  if(kind==='notes')p.notes='Змінено'
  if(kind==='actor')p.created_by=randomUUID()
  if(kind==='date')p.created_at='2020-01-01T00:00:00.000Z'
  if(kind==='qty')p.items[0].qty=2
  if(kind==='missing line')p.items=[]
  if(kind==='extra line')p.items.push({...p.items[0]})
  if(kind==='deleted header')db.prepare('UPDATE writeoffs SET deleted_at=? WHERE id=?').run(new Date().toISOString(),operation.aggregate_id)
  if(kind==='deleted line')db.prepare('UPDATE writeoff_items SET deleted_at=? WHERE writeoff_id=?').run(new Date().toISOString(),operation.aggregate_id)
  if(kind==='line id')p.items[0].id=randomUUID()
  if(kind==='cost')p.items[0].cost_kopecks=1
  if(kind==='line date')p.items[0].created_at='2020-01-01T00:00:00.000Z'
  const before=JSON.parse(JSON.stringify(p)),result=attachBalanceSnapshots(db,[operation])[0].payload
  delete result.local_balance_snapshot
  expect(result).toEqual(before)
 })
 it('does not invent an author for an old anonymous act',()=>{
  const {operation}=legacy()
  db.prepare('UPDATE writeoffs SET created_by=NULL WHERE id=?').run(operation.aggregate_id)
  expect(attachBalanceSnapshots(db,[operation])[0].payload.created_by).toBeNull()
 })
 it('preserves explicitly queued null instead of assigning the current sender',()=>{
  const {operation}=legacy();operation.payload.created_by=null
  expect(attachBalanceSnapshots(db,[operation])[0].payload).toMatchObject({created_by:null,items:[{qty:1.5}]})
  expect(attachBalanceSnapshots(db,[operation])[0].payload.items[0].cost_kopecks).toBeUndefined()
 })
 it('recovers an old act even after its product card is archived',()=>{
  const {operation}=legacy()
  db.prepare('UPDATE products SET deleted_at=? WHERE id=?').run(new Date().toISOString(),product)
  expect(attachBalanceSnapshots(db,[operation])[0].payload.items[0].cost_kopecks).toBe(185)
 })
})
