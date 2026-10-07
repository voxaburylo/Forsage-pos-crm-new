import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach,afterEach,it,expect,vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'
let root:string,db:LocalDatabase,pos:LocalPosRepository,shift:string
const at='2026-10-04T10:00:00.000Z',from='2026-10-03T21:00:00.000Z',to='2026-10-04T20:59:59.999Z'
const run=()=>pos.salesPeriodReport({date_from:from,date_to:to})
beforeEach(()=>{
 root=mkdtempSync(path.join(tmpdir(),'forsage-period-report-'));db=new LocalDatabase(root)
 db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)')
  .run('seller',tenant,'Касир','cashier',at,at)
 pos=new LocalPosRepository(db);shift=pos.openShift({cashier_id:'seller'})
 db.prepare('INSERT INTO products(id,tenant_id,sku,name,unit,qty_on_hand,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run('p',tenant,'P','Тестовий товар','шт',12,at,at)
})
afterEach(()=>{
 db.close()
 if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-period-report-'))rmSync(root,{recursive:true,force:true})
})
function sale(id='s',total=10000,time=at,cost=6000,qty=1){
 db.prepare(`INSERT INTO sales(id,tenant_id,sale_number,cashier_id,shift_id,total,cash_amount,payment_method,completed_at,created_at,updated_at)
 VALUES (?,?,?,'seller',?,?,?,'cash',?,?,?)`).run(id,tenant,id,shift,total,total,time,time,time)
 db.prepare(`INSERT INTO sale_items(id,tenant_id,sale_id,product_id,qty,unit_price,purchase_price,total,created_at,updated_at)
 VALUES (?,?,?,'p',?,?,?,?,?,?)`).run(id,tenant,id,qty,Math.round(total/qty),cost,total,time,time)
}
function refund(action='return_to_stock',amount=10000,time=at,quantity=1,id='r',source='s'){
 db.prepare(`INSERT INTO customer_returns(id,tenant_id,sale_id,reason,refund_method,refund_kopecks,stock_action,status,created_at,updated_at)
 VALUES (?,?,?,'test','cash',?,?,'completed',?,?)`).run(id,tenant,source,amount,action,time,time)
 db.prepare(`INSERT INTO customer_return_items(id,tenant_id,return_id,sale_item_id,product_id,quantity,unit_price_kopecks,total_kopecks,condition,created_at,updated_at)
 VALUES (?,?,?,?,'p',?,?,?,'new',?,?)`).run(id,tenant,id,source,quantity,Math.round(amount/quantity),amount,time,time)
}
it('returns an honest empty report without touching the database',()=>{
 const before=db.prepare('SELECT count(*) count FROM sync_outbox').get()
 const snapshot=vi.spyOn(db,'readSnapshot')
 expect(run()).toMatchObject({total_sales:0,total_revenue:0,net_revenue:0,returns_total:0,payment_received_total:0})
 expect(snapshot).toHaveBeenCalledTimes(1)
 expect(db.prepare('SELECT count(*) count FROM sync_outbox').get()).toEqual(before)
})
it.each([['return_to_stock',0],['write_off',-6000],['send_to_supplier',-6000]] as const)('matches server cost policy for %s', (action,profit)=>{
 sale();refund(action)
 expect(run()).toMatchObject({total_revenue:10000,returns_count:1,returns_total:10000,net_revenue:0,profit})
})
it('does not rewrite yesterday when today returns an old receipt',()=>{
 sale('s',10000,'2026-10-03T10:00:00Z');refund()
 expect(run()).toMatchObject({total_sales:0,net_revenue:-10000,profit:-4000})
 expect(pos.salesPeriodReport({date_from:'2026-10-02T21:00:00Z',date_to:from})).toMatchObject({total_revenue:10000,returns_total:0})
})
it('uses captured fractional costs and discounted total',()=>{
 sale('s',29,at,17,.3);refund('return_to_stock',10,at,.1)
 expect(run()).toMatchObject({profit:16,net_revenue:19})
})
it('honours receipt-wide discount before profit calculation',()=>{
 sale('s',18000,at,5000,2);db.prepare('UPDATE sale_items SET total=20000').run()
 refund('return_to_stock',9000,at,1)
 expect(run()).toMatchObject({profit:4000,total_revenue:18000,net_revenue:9000})
})
it('does not cap a long day at a page boundary',()=>{
 db.transaction(()=>{for(let i=0;i<1205;i++)sale('s'+i,100,at,60)})
 expect(run()).toMatchObject({total_sales:1205,total_revenue:120500,profit:48200})
})
it('counts a mixed receipt with debt, never counting the debt as received money',()=>{
 sale();db.prepare("UPDATE sales SET payment_method='mixed',cash_amount=1000,card_amount=2000,transfer_amount=3000,debt_amount=4000,is_debt=1").run()
 expect(run()).toMatchObject({by_method:{cash:1000,card:2000,transfer:3000,debt:4000},payment_received_total:6000})
})
it('counts prepayments on their own date and preserves archived order linkage',()=>{
 sale()
 db.prepare('INSERT INTO customer_orders(id,tenant_id,sale_id,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?)').run('o',tenant,'s',at,at,at)
 db.prepare("INSERT INTO order_payments(id,tenant_id,order_id,amount,method,created_at,updated_at) VALUES (?,?,?,10000,'transfer',?,?)").run('pay',tenant,'o','2026-10-03T10:00:00Z',at)
 expect(run()).toMatchObject({total_revenue:10000,payment_received_total:0})
 expect(pos.salesPeriodReport({date_from:'2026-10-02T21:00:00Z',date_to:'2026-10-03T20:59:59.999Z'})).toMatchObject({total_revenue:0,payment_received_total:10000})
})
it('keeps returned receipts and ignores canceled returns',()=>{
 sale();refund();db.prepare("UPDATE sales SET status='returned'").run()
 expect(run().total_sales).toBe(1)
 db.prepare("UPDATE customer_returns SET status='canceled'").run()
 expect(run().returns_total).toBe(0)
})
it.each(['sales','sale_items','customer_returns','customer_return_items'])('handles deleted %s without a silently wrong result',table=>{
 sale();refund();db.prepare(`UPDATE ${table} SET deleted_at=?`).run(at)
 if(table==='customer_returns')expect(run().net_revenue).toBe(10000)
 else expect(run).toThrow('неповні')
})
it.each([
 "UPDATE sale_items SET qty=0.0001",
 "UPDATE sale_items SET tenant_id='other'",
 "UPDATE customer_return_items SET total_kopecks=9999",
 "UPDATE sales SET payment_method='mixed',cash_amount=9000",
 "UPDATE sale_items SET purchase_price=-1",
])('rejects corrupt financial rows: %s',sql=>{
 sale();refund();db.prepare(sql).run();expect(run).toThrow('неповні')
})
it.each([['2026-10-03T20:59:59.999Z',0],['2026-10-03T21:00:00Z',1],['2026-10-04T20:59:59.999Z',1],['2026-10-04T21:00:00Z',0]] as const)('compares actual instants at %s', (time,count)=>{
 sale('s',100,time);expect(run().total_sales).toBe(count)
})
it('normalizes offset timestamps rather than comparing strings',()=>{
 sale('s',100,'2026-10-04T00:30:00+03:00')
 expect(run().total_sales).toBe(1)
})
it.each(['','2026-02-30T00:00:00Z','2026-10-04','garbage'])('rejects invalid bounds %s',value=>{
 expect(()=>pos.salesPeriodReport({date_from:value,date_to:to})).toThrow('період')
})
it('rejects a reversed range',()=>expect(()=>pos.salesPeriodReport({date_from:to,date_to:from})).toThrow('період'))
it('does not include receipts from another tenant',()=>{
 sale();refund()
 expect(pos.salesPeriodReport({tenant_id:'another-shop',date_from:from,date_to:to})).toMatchObject({total_sales:0,returns_count:0,payment_received_total:0})
})
it('binds the IPC read to the authenticated shop even when caller omits tenant',async()=>{
 const {readFileSync}=await import('node:fs')
 const source=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8')
 expect(source).toContain('salesPeriodReport({ ...input, tenant_id: requireDesktopSession().tenant_id })')
})
it('matches existing server financial roles and preserves cashier sold-goods access',()=>{
 expect(isDesktopChannelAllowed('desktop:pos:sales-period-report','cashier')).toBe(false)
 expect(isDesktopChannelAllowed('desktop:pos:sales-period-report','manager')).toBe(true)
 expect(isDesktopChannelAllowed('desktop:pos:sales-period-report','owner')).toBe(true)
 expect(isDesktopChannelAllowed('desktop:pos:sold-items-report','cashier')).toBe(true)
 expect(isDesktopChannelAllowed('desktop:pos:sold-items-report','manager')).toBe(true)
})
