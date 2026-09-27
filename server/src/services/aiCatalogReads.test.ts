import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAiDuplicates, readAiLookup, boundedAiReadResult, AI_CATALOG_LIMITS } from './aiCatalogReads.js'
import { AiExecutionBudget } from './aiExecutionBudget.js'
import { createClient } from '@supabase/supabase-js'
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0')
const row=(n:number,extra:Record<string,unknown>={})=>({id:id(n),name:'Товар '+n,sku:'SKU'+n,qty_on_hand:2,retail_price:12000,tenant_id:'shop',deleted_at:null,...extra})
function fakeDb(rows:any[], cap=500) {
 const calls:any[]=[]
 const db={from:(table:string)=>{
  const call:any={table,after:'',limit:500,eq:[],is:[],order:[]};calls.push(call)
  const query:any={
   select:(columns:string)=>{call.columns=columns;return query},
   eq:(...args:any[])=>{call.eq.push(args);return query},
   is:(...args:any[])=>{call.is.push(args);return query},
   order:(...args:any[])=>{call.order.push(args);return query},
   gt:(key:string,value:string)=>{expect(key).toBe('id');call.after=value;return query},
   limit:(limit:number)=>{call.limit=limit;return query},
   abortSignal:(signal:AbortSignal)=>{
    call.signal=signal
    if(db.failure) return db.failure(call)
    const data=rows.filter(r=>call.eq.every(([k,v]:any[])=>r[k]===v)&&call.is.every(([k,v]:any[])=>r[k]===v)&&r.id>call.after)
     .sort((a,b)=>a.id.localeCompare(b.id)).slice(0,Math.min(cap,call.limit))
     .map(r=>Object.fromEntries(call.columns.split(',').map((s:string)=>s.trim()).map((key:string)=>[key,r[key]])))
    return Promise.resolve({data,error:null})
   },
  };return query
 },failure:undefined as undefined|((call:any)=>Promise<any>)}
 return {db:db as any,calls,setFailure:(f:(call:any)=>Promise<any>)=>{db.failure=f}}
}
let budget:AiExecutionBudget
beforeEach(()=>{vi.useFakeTimers();budget=new AiExecutionBudget(240_000)})
afterEach(()=>{budget.dispose();expect(vi.getTimerCount()).toBe(0);vi.useRealTimers()})
describe('bounded tenant-scoped AI catalogue reads',()=>{
 it('serializes scope, cursor and limit through the installed SDK without network access',async()=>{
  const requests:URL[]=[]
  const rows=[row(1,{name:'Олива'}),row(2,{name:'Олива'})]
  const fetchMock=vi.fn(async(input:RequestInfo|URL,options?:RequestInit)=>{
   const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url)
   requests.push(url)
   expect(url.pathname).toBe('/rest/v1/products')
   expect(url.searchParams.get('tenant_id')).toBe('eq.shop')
   expect(url.searchParams.get('deleted_at')).toBe('is.null')
   expect(url.searchParams.get('order')).toBe('id.asc')
   expect(Number(url.searchParams.get('limit'))).toBeLessThanOrEqual(500)
   expect(options?.signal).toBeInstanceOf(AbortSignal)
   const after=(url.searchParams.get('id')??'gt.').slice(3)
   return new Response(JSON.stringify(rows.filter(r=>r.id>after).slice(0,1)),{
    status:200,headers:{'Content-Type':'application/json'},
   })
  })
  const db=createClient('https://catalogue.fixture.invalid','fixture-only-key',{
   auth:{autoRefreshToken:false,persistSession:false,detectSessionInUrl:false},
   global:{fetch:fetchMock as typeof fetch},
  })
  const result=await readAiDuplicates(db,'shop','name',20,budget)
  expect(result.groups[0].products.map(p=>p.product_id)).toEqual([id(1),id(2)])
  expect(requests.map(url=>url.searchParams.get('id'))).toEqual([null,'gt.'+id(1),'gt.'+id(2)])
 })
 it('uses ID cursors, handles a lower server page cap, and excludes other shops/deleted rows',async()=>{
  const rows=[row(1,{name:' Олива 4л '}),row(2,{name:'олива 4л'}),row(3),row(4,{tenant_id:'other'}),row(5,{deleted_at:'now'})]
  const fixture=fakeDb(rows.reverse(),1)
  const result=await readAiDuplicates(fixture.db,'shop','name',20,budget)
  expect(result.total_groups).toBe(1);expect(result.groups[0].products.map(p=>p.product_id)).toEqual([id(1),id(2)])
  expect(fixture.calls.map(c=>c.after)).toEqual(['',id(1),id(2),id(3)])
  for(const call of fixture.calls){
   expect(call.eq).toContainEqual(['tenant_id','shop']);expect(call.is).toContainEqual(['deleted_at',null])
   expect(call.order).toEqual([['id',{ascending:true}]]);expect(call.limit).toBeLessThanOrEqual(500)
   expect(call.signal).toBeInstanceOf(AbortSignal)
  }
 })
 it('groups normalized articles and keeps whole groups rather than truncating members',async()=>{
  const fixture=fakeDb([row(1,{sku:'W 67/1'}),row(2,{sku:'W67-1'}),row(3,{sku:'W811/80'}),row(4,{sku:'W81180'})])
  const result=await readAiDuplicates(fixture.db,'shop','sku',1,budget)
  expect(result.total_groups).toBe(2);expect(result.showing).toBe(1);expect(result.groups[0].products).toHaveLength(2)
 })
 it.each(['categories','brands'] as const)('reads all %s without a hidden per-page cap',async table=>{
  const fixture=fakeDb([row(1),row(2),row(3)],1)
  const result=await readAiLookup(fixture.db,'shop',table,budget)
  expect(result[table]).toHaveLength(3)
  expect(fixture.calls[0].columns).toBe('id, name')
 })
 it('refuses an oversized lookup instead of returning its first rows',async()=>{
  const fixture=fakeDb(Array.from({length:AI_CATALOG_LIMITS.lookups+1},(_,i)=>row(i+1)))
  await expect(readAiLookup(fixture.db,'shop','brands',budget)).rejects.toMatchObject({code:'AI_READ_LIMIT'})
 })
 it('bounds a large product scan and refuses partial duplicate results',async()=>{
  const fixture=fakeDb(Array.from({length:AI_CATALOG_LIMITS.products+1},(_,i)=>row(i+1)))
  await expect(readAiDuplicates(fixture.db,'shop','sku',20,budget)).rejects.toMatchObject({code:'AI_READ_LIMIT'})
  expect(fixture.calls.length).toBeLessThanOrEqual(101)
 })
 it('rejects a repeated/non-advancing page instead of looping',async()=>{
  const fixture=fakeDb([])
  fixture.setFailure(async()=>({data:[row(1)],error:null}))
  await expect(readAiDuplicates(fixture.db,'shop','name',20,budget)).rejects.toMatchObject({code:'AI_READ_FAILED'})
  expect(fixture.calls).toHaveLength(2)
 })
 it('rejects a database error without leaking its contents',async()=>{
  const fixture=fakeDb([])
  fixture.setFailure(async()=>({data:null,error:{message:'secret SQL'}}))
  await expect(readAiLookup(fixture.db,'shop','categories',budget)).rejects.toMatchObject({code:'AI_READ_FAILED',message:'Не вдалося прочитати каталог. Повторіть запит.'})
 })
 it('aborts the actual database signal when a read never returns',async()=>{
  const fixture=fakeDb([])
  fixture.setFailure(()=>new Promise(()=>{}))
  const check=expect(readAiDuplicates(fixture.db,'shop','name',20,budget)).rejects.toMatchObject({code:'AI_TIMEOUT'})
  await vi.advanceTimersByTimeAsync(30_000);await check
  expect(fixture.calls[0].signal.aborted).toBe(true)
 })
 it('respects a shorter parent deadline',async()=>{
  budget.dispose();budget=new AiExecutionBudget(100)
  const fixture=fakeDb([]);fixture.setFailure(()=>new Promise(()=>{}))
  const check=expect(readAiLookup(fixture.db,'shop','brands',budget)).rejects.toMatchObject({code:'AI_TIMEOUT'})
  await vi.advanceTimersByTimeAsync(100);await check
  expect(fixture.calls[0].signal.aborted).toBe(true)
 })
 it('bounds UTF-8 response bytes, not just the count of duplicate groups',()=>{
  expect(boundedAiReadResult({products:[]})).toEqual({products:[]})
  expect(()=>boundedAiReadResult({name:'🙂'.repeat(33_000)})).toThrow('Каталог завеликий')
 })
})
