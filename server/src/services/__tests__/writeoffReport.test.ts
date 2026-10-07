import { PGlite } from '@electric-sql/pglite'
import { beforeAll,afterAll,beforeEach,afterEach,it,expect,vi } from 'vitest'
const state=vi.hoisted(()=>({db:null as any,calls:0,fail:false}))
vi.mock('../../db/pg.js',()=>({pool:{query:async(sql:string,args:any[])=>{
  state.calls++;if(state.fail)throw Error('unavailable');return state.db.query(sql,args)
}}}))
vi.mock('../../db/supabase.js',()=>({db:{from:()=>{throw Error('REST must not be used')}}}))
import { getWriteoffsSummary } from '../reportService.js'
import { aggregateWriteoffs,writeoffMonthRange } from '../../lib/writeoffReport.js'
const run=(month='2026-10',tenant='shop')=>getWriteoffsSummary(tenant,month)
const at='2026-10-05T10:00:00Z'
async function act(id='w',time=at,tenant='shop',cost=123) {
 await state.db.query("INSERT INTO inventory_writeoffs(id,tenant_id,reason,created_at) VALUES($1,$2,'damage',$3)",[id,tenant,time])
 await state.db.query('INSERT INTO inventory_writeoff_items(id,writeoff_id,product_id,qty,cost_kopecks) VALUES($1,$1,\'p\',1,$2)',[id,cost])
}
beforeAll(async()=>{
 state.db=new PGlite()
 await state.db.exec(`
 CREATE TABLE products(id text PRIMARY KEY,tenant_id text,purchase_price int,deleted_at timestamptz);
 CREATE TABLE inventory_writeoffs(id text PRIMARY KEY,tenant_id text,reason text,created_at timestamptz,deleted_at timestamptz);
 CREATE TABLE inventory_writeoff_items(id text PRIMARY KEY,writeoff_id text,product_id text,qty numeric,cost_kopecks numeric,deleted_at timestamptz,tenant_id text);
 `)
})
beforeEach(async()=>{
 state.calls=0;state.fail=false
 await state.db.exec("TRUNCATE inventory_writeoffs,inventory_writeoff_items,products; INSERT INTO products VALUES('p','shop',999,NULL)")
})
afterEach(()=>vi.useRealTimers())
afterAll(async()=>state.db.close())
it('reads all headers and lines once, without recalculating historical cost',async()=>{
 await act();expect(await run()).toMatchObject({month:'2026-10',count:1,total_cost:123,writeoffs:[{total_cost:123}]})
 expect(state.calls).toBe(1)
})
it('returns a genuine empty report, not an error',async()=>expect(await run()).toMatchObject({count:0,total_cost:0,writeoffs:[]}))
it('uses both Kyiv month boundaries, including the DST change',async()=>{
 await act('before','2026-09-30T20:59:59.999Z');await act('first','2026-09-30T21:00:00Z')
 await act('last','2026-10-31T21:59:59.999Z');await act('after','2026-10-31T22:00:00Z')
 expect((await run()).writeoffs.map(w=>w.id)).toEqual(['last','first'])
})
it('defaults to the Kyiv month even before UTC midnight',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-09-30T21:30:00Z'))
 await act('w','2026-09-30T21:00:00Z')
 expect((await getWriteoffsSummary('shop')).month).toBe('2026-10')
})
it.each([['2026-03','2026-02-28T22:00:00.000Z','2026-03-31T21:00:00.000Z'],
 ['2026-10','2026-09-30T21:00:00.000Z','2026-10-31T22:00:00.000Z'],
 ['2028-02','2028-01-31T22:00:00.000Z','2028-02-29T22:00:00.000Z'],
 ['2026-12','2026-11-30T22:00:00.000Z','2026-12-31T22:00:00.000Z']])('builds exact boundaries for %s', (month,from,toExclusive)=>{
 expect(writeoffMonthRange(month)).toEqual({from,toExclusive})
})
it.each(['','2026-13','2026-00','26-10','2026-1','2026-10-01','9999-12',null])('rejects malformed month %s before querying',async month=>{
 await expect(run(month as any)).rejects.toMatchObject({status:400});expect(state.calls).toBe(0)
})
it('excludes another tenant and deleted acts, but retains archived product history',async()=>{
 await act();await act('foreign',at,'other');await act('deleted')
 await state.db.exec("UPDATE inventory_writeoffs SET deleted_at=now() WHERE id='deleted';UPDATE products SET deleted_at=now()")
 expect((await run()).writeoffs.map(w=>w.id)).toEqual(['w'])
})
it.each(['empty','deleted line','foreign line','foreign product','missing product','null cost','negative cost','fractional cost','zero qty','null qty','fractional precision','reason'])('blocks %s rather than reporting a smaller or fake zero amount',async kind=>{
 await act()
 const sql:Record<string,string>={
 empty:'DELETE FROM inventory_writeoff_items',
 'deleted line':'UPDATE inventory_writeoff_items SET deleted_at=now()',
 'foreign line':"UPDATE inventory_writeoff_items SET tenant_id='other'",
 'foreign product':"UPDATE products SET tenant_id='other'",
 'missing product':'DELETE FROM products',
 'null cost':'UPDATE inventory_writeoff_items SET cost_kopecks=NULL',
 'negative cost':'UPDATE inventory_writeoff_items SET cost_kopecks=-1',
 'fractional cost':'UPDATE inventory_writeoff_items SET cost_kopecks=1.1',
 'zero qty':'UPDATE inventory_writeoff_items SET qty=0',
 'null qty':'UPDATE inventory_writeoff_items SET qty=NULL',
 'fractional precision':'UPDATE inventory_writeoff_items SET qty=0.0001',
 reason:"UPDATE inventory_writeoffs SET reason='unknown'"}
 await state.db.exec(sql[kind]);await expect(run()).rejects.toMatchObject({code:'INCOMPLETE_REPORT',status:503})
})
it('does not truncate more than 1000 acts',async()=>{
 await state.db.exec(`INSERT INTO inventory_writeoffs SELECT 'w'||n,'shop','loss','2026-10-05',NULL FROM generate_series(1,1205)n;
 INSERT INTO inventory_writeoff_items SELECT 'w'||n,'w'||n,'p',1,100,NULL,NULL FROM generate_series(1,1205)n`)
 expect(await run()).toMatchObject({count:1205,total_cost:120500});expect(state.calls).toBe(1)
})
it('does not truncate a single act with more than 1000 lines',async()=>{
 await act()
 await state.db.exec(`INSERT INTO products SELECT 'p'||n,'shop',999,NULL FROM generate_series(1,1205)n;
 INSERT INTO inventory_writeoff_items SELECT 'i'||n,'w','p'||n,0.001,1,NULL,NULL FROM generate_series(1,1205)n`)
 expect((await run()).writeoffs[0].items).toHaveLength(1206)
 expect((await run()).total_cost).toBe(1328)
})
it('accepts a true zero historical cost',async()=>{await act('w',at,'shop',0);expect((await run()).total_cost).toBe(0)})
it('does not hide a database failure as an empty month',async()=>{state.fail=true;await expect(run()).rejects.toThrow('unavailable')})
it('rejects orphan/duplicate lines and unsafe totals at the calculation boundary',()=>{
 const doc={id:'w',reason:'loss',created_at:at}
 const line={id:'l',writeoff_id:'w',product_id:'p',known_product_id:'p',qty:1,cost_kopecks:1,deleted:false,tenant_matches:true}
 for(const snapshot of [
  {documents:[doc],lines:[line,line]},
  {documents:[],lines:[line]},
  {documents:[doc,doc],lines:[line]},
  {documents:[doc],lines:[line,{...line,id:'other'}]},
  {documents:[doc],lines:[{...line,cost_kopecks:Number.MAX_SAFE_INTEGER},{...line,id:'l2',product_id:'p2',known_product_id:'p2'}]},
 ])expect(()=>aggregateWriteoffs(snapshot,'2026-10')).toThrow('неповні')
})
