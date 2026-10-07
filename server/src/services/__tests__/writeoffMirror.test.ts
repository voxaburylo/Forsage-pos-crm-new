import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { beforeAll,afterAll,beforeEach,describe,it,expect,vi } from 'vitest'
const state=vi.hoisted(()=>({db:null as any,failLine:false,queries:[] as string[]}))
vi.mock('../../db/pg.js',()=>({runTransaction:(fn:any)=>state.db.transaction((tx:any)=>fn({
 query:async(sql:string,args:any[])=>{
  state.queries.push(sql)
  if(state.failLine&&sql.includes('INSERT INTO inventory_writeoff_items'))throw Error('injected line failure')
  const result=await tx.query(sql,args);return {...result,rowCount:result.rows.length||result.affectedRows||0}
 }
}))}))
vi.mock('../../db/supabase.js',()=>({db:{}}))
import { applyWriteoffCreated } from '../sync/inventoryHandlers.js'
const tenant=randomUUID(),other=randomUUID(),actor=randomUUID(),uploader=randomUUID(),product=randomUUID(),second=randomUUID()
const at='2026-09-29T10:00:00.000Z',applied='2026-10-05T12:00:00.000Z'
const rows=async(sql:string,args:any[]=[]) => (await state.db.query(sql,args)).rows as any[]
function operation():any {
 const id=randomUUID()
 return {sequence:1,operation_id:randomUUID(),aggregate_id:id,aggregate_type:'writeoff',operation_type:'writeoff.created',
 tenant_id:tenant,device_id:'primary',created_at:at,applied_at:applied,balance_mirrored:true,
 payload:{id,reason:'damage',notes:'Пошкоджена упаковка',created_by:actor,created_at:at,
 items:[{id:randomUUID(),product_id:product,qty:1.5,cost_kopecks:185,created_at:at}]}}
}
beforeAll(async()=>{
 state.db=new PGlite()
 await state.db.exec(`
 CREATE TABLE products(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,purchase_price int,qty_on_hand numeric,deleted_at timestamptz,updated_at timestamptz);
 CREATE TABLE inventory_writeoffs(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,reason text NOT NULL,notes text,created_by uuid NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz);
 CREATE TABLE inventory_writeoff_items(id uuid PRIMARY KEY,writeoff_id uuid NOT NULL REFERENCES inventory_writeoffs,product_id uuid NOT NULL REFERENCES products,qty numeric(12,3) CHECK(qty>0),cost_kopecks int NOT NULL,created_at timestamptz NOT NULL,UNIQUE(writeoff_id,product_id));
 `)
})
afterAll(async()=>state.db.close())
beforeEach(async()=>{
 state.failLine=false;state.queries=[]
 await state.db.exec('TRUNCATE inventory_writeoff_items,inventory_writeoffs,products CASCADE')
 await state.db.query('INSERT INTO products(id,tenant_id,purchase_price,qty_on_hand) VALUES($1,$2,999,0),($3,$2,200,5)',[product,tenant,second])
})
describe('immutable local writeoff copies',()=>{
 it('copies original cost, line IDs, author and date, never today\'s catalog cost or uploader',async()=>{
  const op=operation();await applyWriteoffCreated(tenant,uploader,op)
  expect(await rows('SELECT created_by,created_at FROM inventory_writeoffs')).toEqual([{created_by:actor,created_at:new Date(at)}])
  expect(await rows('SELECT id,qty,cost_kopecks FROM inventory_writeoff_items')).toEqual([{id:op.payload.items[0].id,qty:'1.500',cost_kopecks:185}])
  expect((await rows('SELECT qty_on_hand FROM products WHERE id=$1',[product]))[0].qty_on_hand).toBe('0')
 })
 it('does not acknowledge a changed or incomplete copy merely because its header exists',async()=>{
  const op=operation();await applyWriteoffCreated(tenant,uploader,op)
  await state.db.query('DELETE FROM inventory_writeoff_items WHERE writeoff_id=$1',[op.aggregate_id])
  await expect(applyWriteoffCreated(tenant,uploader,op)).rejects.toMatchObject({status:409})
 })
 it.each(['qty','cost','product','line id','line date','reason','notes','author','date'])('rejects changed %s on retry without overwriting history',async field=>{
  const op=operation();await applyWriteoffCreated(tenant,uploader,op)
  const before=await rows('SELECT * FROM inventory_writeoff_items')
  const p=op.payload,i=p.items[0]
  if(field==='qty')i.qty=2
  if(field==='cost')i.cost_kopecks=200
  if(field==='product')i.product_id=second
  if(field==='line id')i.id=randomUUID()
  if(field==='line date')i.created_at=applied
  if(field==='reason')p.reason='loss'
  if(field==='notes')p.notes='Інший акт'
  if(field==='author')p.created_by=uploader
  if(field==='date')p.created_at=applied
  await expect(applyWriteoffCreated(tenant,uploader,op)).rejects.toMatchObject({status:409})
  expect(await rows('SELECT * FROM inventory_writeoff_items')).toEqual(before)
 })
 it('acknowledges the same full document once, with no timestamp churn',async()=>{
  const op=operation();await applyWriteoffCreated(tenant,uploader,op)
  const before=await rows('SELECT * FROM inventory_writeoffs')
  op.applied_at='2026-10-06T12:00:00Z'
  await applyWriteoffCreated(tenant,uploader,op)
  expect(await rows('SELECT * FROM inventory_writeoffs')).toEqual(before)
  expect(await rows('SELECT * FROM inventory_writeoff_items')).toHaveLength(1)
 })
 it('does not consume stock for a legacy unsigned local copy',async()=>{
  const op=operation();delete op.balance_mirrored
  const before=await rows('SELECT * FROM products ORDER BY id')
  await applyWriteoffCreated(tenant,uploader,op)
  expect(await rows('SELECT * FROM products ORDER BY id')).toEqual(before)
 })
 it('accepts archived historical products without restoring them',async()=>{
  await state.db.query('UPDATE products SET deleted_at=$1 WHERE id=$2',[at,product])
  await applyWriteoffCreated(tenant,uploader,operation())
  expect((await rows('SELECT deleted_at FROM products WHERE id=$1',[product]))[0].deleted_at).toEqual(new Date(at))
 })
 it.each(['operation tenant','foreign product','missing product','foreign document'])('rejects %s',async kind=>{
  const op=operation()
  if(kind==='operation tenant')op.tenant_id=other
  if(kind==='foreign product')await state.db.query('UPDATE products SET tenant_id=$1 WHERE id=$2',[other,product])
  if(kind==='missing product')op.payload.items[0].product_id=randomUUID()
  if(kind==='foreign document')await state.db.query("INSERT INTO inventory_writeoffs VALUES($1,$2,'other',NULL,$3,$4,$4)",[op.aggregate_id,other,actor,at])
  await expect(applyWriteoffCreated(tenant,uploader,op)).rejects.toThrow()
  expect(await rows('SELECT * FROM inventory_writeoff_items')).toEqual([])
 })
 it.each([
 ['missing cost',(p:any)=>{delete p.items[0].cost_kopecks}],
 ['missing line id',(p:any)=>{delete p.items[0].id}],
 ['missing actor',(p:any)=>{delete p.created_by}],
 ['missing line date',(p:any)=>{delete p.items[0].created_at}],
 ['missing date',(p:any)=>{delete p.created_at}],
 ['negative cost',(p:any)=>{p.items[0].cost_kopecks=-1}],
 ['fractional kopeck',(p:any)=>{p.items[0].cost_kopecks=1.5}],
 ['string qty',(p:any)=>{p.items[0].qty='1'}],
 ['null qty',(p:any)=>{p.items[0].qty=null}],
 ['overprecise qty',(p:any)=>{p.items[0].qty=.0001}],
 ['zero qty',(p:any)=>{p.items[0].qty=0}],
 ['NaN qty',(p:any)=>{p.items[0].qty=NaN}],
 ['invalid date',(p:any)=>{p.created_at='bad'}],
 ['wrong id',(p:any)=>{p.id=randomUUID()}],
 ['duplicate product',(p:any)=>{p.items.push({...p.items[0],id:randomUUID()})}],
 ['duplicate line id',(p:any)=>{p.items.push({...p.items[0],product_id:second})}],
 ['total cost overflow',(p:any)=>{p.items[0].cost_kopecks=2147483647;p.items.push({...p.items[0],id:randomUUID(),product_id:second,cost_kopecks:1})}],
 ])('rejects %s without a partial document',async(_label,change)=>{
  const op=operation();(change as (p:any)=>void)(op.payload)
  await expect(applyWriteoffCreated(tenant,uploader,op)).rejects.toThrow()
  expect(await rows('SELECT * FROM inventory_writeoffs')).toEqual([])
  expect(await rows('SELECT * FROM inventory_writeoff_items')).toEqual([])
 })
 it('rolls back header and lines when line insertion fails',async()=>{
  state.failLine=true
  await expect(applyWriteoffCreated(tenant,uploader,operation())).rejects.toThrow('injected line failure')
  expect(await rows('SELECT * FROM inventory_writeoffs')).toEqual([])
 })
 it('does not steal an existing line ID from another document',async()=>{
  const first=operation();await applyWriteoffCreated(tenant,uploader,first)
  const next=operation();next.payload.items[0].id=first.payload.items[0].id
  await expect(applyWriteoffCreated(tenant,uploader,next)).rejects.toThrow()
  expect(await rows('SELECT * FROM inventory_writeoffs')).toHaveLength(1)
 })
 it('serializes repeated delivery into a single complete document',async()=>{
  const op=operation()
  await Promise.all([applyWriteoffCreated(tenant,uploader,op),applyWriteoffCreated(tenant,uploader,op)])
  expect(await rows('SELECT * FROM inventory_writeoffs')).toHaveLength(1)
  expect(await rows('SELECT * FROM inventory_writeoff_items')).toHaveLength(1)
 })
 it('supports zero historical cost and exact thousandths',async()=>{
  const op=operation();op.payload.items[0].cost_kopecks=0;op.payload.items[0].qty=.001
  await applyWriteoffCreated(tenant,uploader,op)
  expect(await rows('SELECT qty,cost_kopecks FROM inventory_writeoff_items')).toEqual([{qty:'0.001',cost_kopecks:0}])
 })
})
