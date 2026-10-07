import { PGlite } from '@electric-sql/pglite'
import { beforeAll,beforeEach,afterAll,expect,it,vi } from 'vitest'
import { readFileSync } from 'node:fs'
const state=vi.hoisted(()=>({db:null as any,calls:0,fail:false}))
vi.mock('../../db/pg.js',()=>({pool:{query:async(sql:string,args:unknown[])=>{
  state.calls++;if(state.fail)throw Error('offline');return state.db.query(sql,args)
}}}))
import { getSalesPeriod,getSalesToday,getWeeklySales } from '../reportService.js'
vi.mock('../../db/supabase.js',()=>({db:{from:vi.fn(()=>{throw Error('REST must not be used')})}}))
const day='2026-10-04',at=day+'T10:00:00Z',tenant='shop'
const run=(from=day,to=from)=>getSalesPeriod({from,to},tenant)
beforeAll(async()=>{
 state.db=new PGlite()
 await state.db.exec(`
 CREATE TABLE sales(id text primary key,tenant_id text,sale_number text,status text,total int,completed_at timestamptz,created_at timestamptz,
 payment_method text,cash_amount int,card_amount int,transfer_amount int,debt_amount int,is_debt bool,customer_id text,deleted_at timestamptz);
 CREATE TABLE sale_items(id text primary key,tenant_id text,sale_id text,qty numeric,total int,cost_price int,deleted_at timestamptz);
 CREATE TABLE returns(id text primary key,tenant_id text,sale_id text,created_at timestamptz,status text,stock_action text,refund_kopecks int,refund_amount int,deleted_at timestamptz);
 CREATE TABLE return_items(id text primary key,tenant_id text,return_id text,sale_item_id text,quantity numeric,total_kopecks int,deleted_at timestamptz);
 CREATE TABLE customer_orders(id text primary key,tenant_id text,sale_id text,deleted_at timestamptz);
 CREATE TABLE order_payments(id text primary key,tenant_id text,order_id text,amount int,method text,created_at timestamptz,deleted_at timestamptz);
 CREATE TABLE customers(id text primary key,tenant_id text,phone text,full_name text,deleted_at timestamptz);
 `)
},30000)
beforeEach(async()=>{
 state.calls=0;state.fail=false
 await state.db.exec('TRUNCATE sales,sale_items,returns,return_items,customer_orders,order_payments,customers')
})
afterAll(async()=>{vi.useRealTimers();await state.db?.close()})
async function sale(id='s',total=10000,time=at,cost=6000,qty=1){
 await state.db.query(`INSERT INTO sales VALUES($1,'shop',$1,'completed',$2,$3,$3,'cash',$2,0,0,0,false,NULL,NULL)`,[id,total,time])
 await state.db.query("INSERT INTO sale_items VALUES($1,'shop',$1,$2,$3,$4,NULL)",[id,qty,total,cost])
}
async function refund(action='return_to_stock',amount=10000,time=at,quantity=1,id='r',source='s'){
 await state.db.query("INSERT INTO returns VALUES($1,'shop',$2,$3,'completed',$4,$5,$5,NULL)",[id,source,time,action,amount])
 await state.db.query("INSERT INTO return_items VALUES($1,'shop',$1,$2,$3,$4,NULL)",[id,source,quantity,amount])
}
it.each([['return_to_stock',0],['write_off',-6000],['send_to_supplier',-6000]])('full %s return uses captured cost and net revenue',async(action,profit)=>{
 await sale();await refund(String(action))
 expect(await run()).toMatchObject({total_revenue:10000,returns_total:10000,net_revenue:0,returns_count:1,profit})
 expect(state.calls).toBe(1)
})
it.each([['return_to_stock',-4000],['write_off',-10000],['send_to_supplier',-10000]])('refund-only day for %s stays negative',async(action,profit)=>{
 await sale('s',10000,'2026-10-03T10:00:00Z');await refund(String(action))
 expect(await run()).toMatchObject({total_sales:0,total_revenue:0,returns_total:10000,net_revenue:-10000,profit})
 expect(await run('2026-10-03')).toMatchObject({total_revenue:10000,returns_total:0,net_revenue:10000,profit:4000})
})
it('uses the same reducer in local and server builds',()=>{
 const root=new URL('../../../../',import.meta.url)
 const local=readFileSync(new URL('apps/desktop/src/lib/periodReport.ts',root),'utf8').replaceAll('\r\n','\n')
 expect(local).toBe(readFileSync(new URL('server/src/lib/periodReport.ts',root),'utf8').replaceAll('\r\n','\n'))
})
it('uses captured historical cost and the discounted receipt total, not current product cost',async()=>{
 await sale('s',18000,at,5000,2)
 await state.db.exec('UPDATE sale_items SET total=20000')
 await refund('return_to_stock',9000,at,1)
 expect(await run()).toMatchObject({total_revenue:18000,returns_total:9000,net_revenue:9000,profit:4000})
})
it('reads all rows beyond REST limits in one snapshot',async()=>{
 await state.db.exec(`INSERT INTO sales SELECT 's'||i,'shop','s'||i,'completed',100,'2026-10-04T10:00:00Z','2026-10-04T10:00:00Z','cash',100,0,0,0,false,NULL,NULL FROM generate_series(1,1205)i;
 INSERT INTO sale_items SELECT 's'||i,'shop','s'||i,1,100,60,NULL FROM generate_series(1,1205)i;`)
 expect(await run()).toMatchObject({total_sales:1205,total_revenue:120500,profit:48200})
 expect(state.calls).toBe(1)
})
it('includes every dated return beyond a page limit',async()=>{
 await sale('s',5050000,at,6000,505)
 for(let i=0;i<505;i++)await refund(i===504?'return_to_stock':'write_off',10000,at,1,'r'+i)
 expect(await run()).toMatchObject({returns_count:505,profit:-504*6000,net_revenue:0})
})
it('does not present query failures as zero or incomplete data as profit',async()=>{
 await sale();state.fail=true;await expect(run()).rejects.toThrow('offline')
 state.fail=false;await state.db.exec('DELETE FROM sale_items');await expect(run()).rejects.toMatchObject({code:'INCOMPLETE_REPORT'})
})
it.each(['sales','sale_items','returns','return_items'])('excludes deleted %s or refuses its incomplete document',async table=>{
 await sale();await refund();await state.db.exec(`UPDATE ${table} SET deleted_at=now()`)
 if(table==='returns')expect(await run()).toMatchObject({returns_total:0,net_revenue:10000})
 else await expect(run()).rejects.toMatchObject({code:'INCOMPLETE_REPORT'})
})
it('does not mix other stores, drafts and future refunds',async()=>{
 await sale();await refund()
 await state.db.exec("UPDATE returns SET status='draft';INSERT INTO sales SELECT 'other','alien','other','completed',99999,completed_at,created_at,'cash',99999,0,0,0,false,NULL,NULL FROM sales LIMIT 1")
 expect(await run()).toMatchObject({total_sales:1,returns_count:0,total_revenue:10000})
 await state.db.exec("UPDATE returns SET status='completed',created_at='2026-10-05T10:00:00Z'")
 expect((await run()).returns_count).toBe(0)
})
it.each([
 ['cash',{cash_amount:10000}],['card',{payment_method:'card',cash_amount:0,card_amount:10000}],
 ['transfer',{payment_method:'transfer',cash_amount:0,transfer_amount:10000}],
 ['debt',{payment_method:'debt',cash_amount:0,debt_amount:10000,is_debt:true}],
 ['mixed',{payment_method:'mixed',cash_amount:1000,card_amount:2000,transfer_amount:3000,debt_amount:4000,is_debt:true}],
])('preserves %s payment split and separates debt from money received',async(_kind,changes)=>{
 await sale()
 for(const [key,value] of Object.entries(changes))await state.db.query(`UPDATE sales SET ${key}=$1`,[value])
 const report=await run()
 expect(report.by_method.cash+report.by_method.card+report.by_method.transfer+report.by_method.debt).toBe(10000)
 expect(report.payment_received_total).toBe(10000-report.by_method.debt)
})
it('accepts a legacy pure cash receipt but does not invent missing mixed payments',async()=>{
 await sale();await state.db.exec('UPDATE sales SET cash_amount=0')
 expect((await run()).by_method.cash).toBe(10000)
 await state.db.exec("UPDATE sales SET payment_method='mixed'")
 await expect(run()).rejects.toMatchObject({code:'INCOMPLETE_REPORT'})
})
it('preserves legacy NULL debt only when it is explicitly a debt sale',async()=>{
 await sale();await state.db.exec("UPDATE sales SET payment_method='mixed',cash_amount=3000,debt_amount=NULL,is_debt=true")
 expect((await run()).by_method.debt).toBe(7000)
 await state.db.exec('UPDATE sales SET is_debt=false')
 await expect(run()).rejects.toMatchObject({code:'INCOMPLETE_REPORT'})
})
it('counts order prepayments on their own date, not again at pickup',async()=>{
 await sale()
 await state.db.exec(`INSERT INTO customer_orders VALUES('o','shop','s',NULL);
 INSERT INTO order_payments VALUES('p','shop','o',10000,'transfer','2026-10-03T10:00:00Z',NULL)`)
 expect(await run()).toMatchObject({total_revenue:10000,payment_received_total:0})
 expect(await run('2026-10-03')).toMatchObject({total_revenue:0,payment_received_total:10000,by_method:{transfer:10000}})
 await state.db.exec("UPDATE customer_orders SET deleted_at=now()")
 expect((await run()).payment_received_total).toBe(0)
})
it('includes account payments separately from cash and ignores deleted payments',async()=>{
 await state.db.exec(`INSERT INTO customer_orders VALUES('o','shop',NULL,NULL);
 INSERT INTO order_payments VALUES('p','shop','o',200,'account','2026-10-04T10:00:00Z',NULL)`)
 expect(await run()).toMatchObject({total_sales:0,payment_received_total:200,by_method:{account:200,cash:0}})
 await state.db.exec("UPDATE order_payments SET deleted_at=now()")
 expect((await run()).payment_received_total).toBe(0)
})
it.each(['missing','alien','duplicate'])('rejects %s order links',async kind=>{
 await sale()
 if(kind==='duplicate')await state.db.exec("INSERT INTO customer_orders VALUES('o','shop','s',NULL),('o2','shop','s',NULL)")
 else await state.db.exec(`INSERT INTO order_payments VALUES('p','shop','o',100,'cash','2026-10-04T10:00:00Z',NULL);
 INSERT INTO customer_orders VALUES('o','${kind==='alien'?'alien':'missing'}',NULL,NULL)`)
 await expect(run()).rejects.toMatchObject({code:'INCOMPLETE_REPORT'})
})
it.each([
 'UPDATE returns SET refund_kopecks=9999',
 'UPDATE return_items SET quantity=2',
 "UPDATE return_items SET sale_item_id='missing'",
 "UPDATE returns SET sale_id='missing'",
 "UPDATE sale_items SET tenant_id='alien'",
 "UPDATE sale_items SET cost_price=-1",
 'UPDATE sale_items SET qty=0.0001',
])('rejects a broken financial relation: %s',async sql=>{
 await sale();await refund();await state.db.exec(sql);await expect(run()).rejects.toMatchObject({code:'INCOMPLETE_REPORT'})
})
it('keeps integer kopecks for fractional costs and refunds',async()=>{
 await sale('s',29,at,17,.3);await refund('return_to_stock',10,at,.1)
 expect(await run()).toMatchObject({profit:16,net_revenue:19})
})
it('keeps archived customer names but refuses another stores customer',async()=>{
 await sale();await state.db.exec("INSERT INTO customers VALUES('c','shop','123','Архів',now());UPDATE sales SET customer_id='c'")
 expect((await run()).sales[0].customer?.full_name).toBe('Архів')
 await state.db.exec("UPDATE customers SET tenant_id='other'")
 await expect(run()).rejects.toMatchObject({code:'INCOMPLETE_REPORT'})
})
it.each([['2026-10-03T20:59:59.999Z',0],['2026-10-03T21:00:00Z',1],['2026-10-04T20:59:59.999Z',1],['2026-10-04T21:00:00Z',0]] as const)('uses Kyiv boundary %s',async(time,count)=>{
 await sale('s',10000,time);expect((await run()).total_sales).toBe(count)
})
it('uses a 25-hour Kyiv transition day',async()=>{
 await sale('a',100,'2026-10-24T21:00:00Z',0);await sale('b',100,'2026-10-25T21:59:59.999Z',0)
 expect((await run('2026-10-25')).total_sales).toBe(2)
})
it.each(['','2026-02-30','2026-13-01','2026-2-01','9999-01-01'])('rejects invalid date %s before querying',async date=>{
 await expect(run(date)).rejects.toMatchObject({code:'VALIDATION_ERROR'});expect(state.calls).toBe(0)
})
it('rejects reversed dates',async()=>{await expect(run(day,'2026-10-03')).rejects.toMatchObject({code:'VALIDATION_ERROR'})})
it('keeps weekly and daily totals aligned with dated returns',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(at))
 await sale('s',10000,'2026-10-03T10:00:00Z');await refund()
 expect(await getSalesToday(tenant)).toMatchObject({net_revenue:-10000,returns_total:10000})
 const week=await getWeeklySales(tenant)
 expect(week).toHaveLength(7);expect(week.at(-1)?.revenue).toBe(-10000);expect(week.at(-2)?.revenue).toBe(10000)
 expect(week.reduce((a,d)=>a+d.revenue,0)).toBe(0);vi.useRealTimers()
})
