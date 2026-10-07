import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { readSoldItems } from '../src/repositories/pos/soldItemsReport'
let root:string,db:LocalDatabase,shift:string,pos:LocalPosRepository
const at='2026-10-04T10:00:00.000Z',from='2026-10-03T21:00:00.000Z',to='2026-10-04T20:59:59.999Z'
const run=()=>pos.soldItemsReport({date_from:from,date_to:to})
beforeEach(()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(at))
 root=mkdtempSync(path.join(tmpdir(),'forsage-sold-report-'));db=new LocalDatabase(root)
 db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)')
  .run('seller',tenant,'Касир','cashier',at,at)
 pos=new LocalPosRepository(db)
 shift=pos.openShift({cashier_id:'seller'})
 db.prepare('INSERT INTO products(id,tenant_id,sku,name,unit,qty_on_hand,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run('p',tenant,'WA9428','Фільтр WIX WA9428','шт',3,at,at)
})
afterEach(()=>{
 db.close();vi.useRealTimers()
 if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-sold-report-'))rmSync(root,{recursive:true,force:true})
})
function sale(id='s',time=at,qty=1,total=10000,manager:string|null=null){
 db.prepare(`INSERT INTO sales(id,tenant_id,sale_number,cashier_id,manager_id,shift_id,status,total,payment_method,completed_at,created_at,updated_at)
 VALUES (?,?,?,'seller',?,?,'completed',?,'cash',?,?,?)`).run(id,tenant,id,manager,shift,total,time,time,time)
 db.prepare(`INSERT INTO sale_items(id,tenant_id,sale_id,product_id,qty,unit_price,total,created_at,updated_at)
 VALUES (?,?,?,'p',?,?,?, ?,?)`).run(id,tenant,id,qty,Math.round(total/qty),total,time,time)
}
function refund(id='r',source='s',quantity=1,amount=10000,time=at){
 db.prepare(`INSERT INTO customer_returns(id,tenant_id,sale_id,reason,refund_method,refund_kopecks,stock_action,status,created_at,updated_at)
 VALUES (?,?,?,'test','cash',?,'return_to_stock','completed',?,?)`).run(id,tenant,source,amount,time,time)
 db.prepare(`INSERT INTO customer_return_items(id,tenant_id,return_id,sale_item_id,product_id,quantity,unit_price_kopecks,total_kopecks,condition,created_at,updated_at)
 VALUES (?,?,?,?,'p',?,?,?,'new',?,?)`).run(id,tenant,id,source,quantity,Math.round(amount/quantity),amount,time,time)
}
it('uses the same financial reducer as the server',()=>{
 const local=readFileSync(new URL('../src/lib/soldItems.ts',import.meta.url),'utf8').replaceAll('\r\n','\n')
 const server=readFileSync(new URL('../../../server/src/lib/soldItems.ts',import.meta.url),'utf8').replaceAll('\r\n','\n').replace("'./receiptRevenue.js'","'./receiptRevenue'")
 expect(local).toBe(server)
})
it('subtracts a return on its own date, never rewrites the original day',()=>{
 sale('s','2026-10-03T10:00:00.000Z');refund()
 expect(run()[0]).toMatchObject({qty_sold:0,qty_returned:1,qty_net:-1,revenue:0,net_revenue:-10000})
 expect(readSoldItems(db,tenant,'2026-10-02T21:00:00.000Z','2026-10-03T20:59:59.999Z')[0])
  .toMatchObject({qty_sold:1,qty_returned:0,net_revenue:10000})
})
it('allocates discounts across all receipt lines before excluding services and free-price lines',()=>{
 sale('s',at,2,27000);db.prepare('UPDATE sale_items SET total=20000').run()
 db.prepare('INSERT INTO products(id,tenant_id,sku,name,unit,is_service,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)')
  .run('service',tenant,'service','Послуга','шт',at,at)
 for(const [id,product] of [['service','service'],['free',null]]){
  db.prepare(`INSERT INTO sale_items(id,tenant_id,sale_id,product_id,qty,unit_price,total,created_at,updated_at)
   VALUES (?,?, 's',?,1,5000,5000,?,?)`).run(id,tenant,product,at,at)
 }
 refund('r','s',1,9000)
 expect(run()[0]).toMatchObject({qty_sold:2,qty_net:1,revenue:18000,refund_total:9000,net_revenue:9000})
})
it('keeps exact quantity and seller totals',()=>{
 for(let i=0;i<10;i++)sale('s'+i,at,.1,1,i%2?'one':'two')
 const row=run()[0];expect(row.qty_sold).toBe(1);expect(row.revenue).toBe(10)
 expect(row.sellers.map(s=>s.qty_sold)).toEqual([.5,.5])
})
it('keeps archived goods and staff plus the primary alias barcode',()=>{
 sale()
 db.prepare("UPDATE products SET deleted_at=?").run(at);db.prepare("UPDATE staff_users SET deleted_at=?").run(at)
 db.prepare('INSERT INTO product_barcodes(id,tenant_id,product_id,barcode,is_primary,created_at,updated_at) VALUES (?,?,?,?,1,?,?)')
 .run(randomUUID(),tenant,'p','2000000000123',at,at)
 expect(run()[0]).toMatchObject({barcode:'2000000000123',sellers:[expect.objectContaining({id:'seller',name:'Касир'})]})
})
it('ignores draft, cancelled and deleted receipts and future returns',()=>{
 sale();sale('draft');sale('cancelled');sale('deleted')
 db.prepare("UPDATE sales SET status='draft' WHERE id='draft'").run()
 db.prepare("UPDATE sales SET status='cancelled' WHERE id='cancelled'").run()
 db.prepare("UPDATE sales SET deleted_at=? WHERE id='deleted'").run(at)
 refund('future','s',1,10000,'2026-10-05T10:00:00Z')
 expect(run()[0]).toMatchObject({qty_sold:1,qty_returned:0,net_revenue:10000})
})
it('attributes a return to the saved seller before edited order manager',()=>{
 sale('s',at,1,10000,'original');refund()
 db.prepare("INSERT INTO customer_orders(id,tenant_id,manager_id,status,sale_id,created_at,updated_at) VALUES (?,?,?,'completed','s',?,?)")
  .run('o',tenant,'replacement',at,at)
 expect(run()[0].sellers[0]).toMatchObject({id:'original',qty_sold:1,qty_returned:1})
})
it('uses the linked manager for a legacy receipt, detects duplicate order links',()=>{
 sale()
 const insert=db.prepare("INSERT INTO customer_orders(id,tenant_id,manager_id,status,sale_id,created_at,updated_at) VALUES (?,?,?,'completed','s',?,?)")
 insert.run('o',tenant,'manager',at,at)
 expect(run()[0].sellers[0].id).toBe('manager')
 insert.run('o2',tenant,'manager',at,at)
 expect(run).toThrow('неузгоджені')
})
it.each([
 ['2026-10-03T20:59:59.999Z',0],['2026-10-03T21:00:00Z',1],['2026-10-04T20:59:59.999Z',1],
 ['2026-10-04T21:00:00Z',0],['2026-10-04T00:00:00+03:00',1],['2026-10-05T00:00:00+03:00',0],
] as const)('compares actual instants including old timestamp format %s',(time,count)=>{
 sale('s',time);expect(run()).toHaveLength(count)
})
it.each(['','wrong','2026-10-04','2026-10-03T25:00:00Z','2026-02-30T10:00:00Z'])('rejects malformed timestamp %s',value=>{
 expect(()=>readSoldItems(db,tenant,value,to)).toThrow('період')
})
it('rejects reversed timestamps',()=>{expect(()=>readSoldItems(db,tenant,to,from)).toThrow('період')})
it.each([
 "UPDATE sale_items SET deleted_at='gone'",'UPDATE sale_items SET qty=0','UPDATE sales SET total=10001',
 "UPDATE products SET tenant_id='other'",'UPDATE sale_items SET qty=.0001',
])('does not display incomplete sale: %s',sql=>{
 sale();db.prepare(sql).run();expect(run).toThrow('неузгоджені')
})
it.each([
 "UPDATE customer_return_items SET deleted_at='gone'",'UPDATE customer_return_items SET quantity=2',
 'UPDATE customer_return_items SET product_id=NULL','UPDATE customer_returns SET refund_kopecks=9999',
])('does not display incomplete refund: %s',sql=>{
 sale();refund();db.prepare(sql).run();expect(run).toThrow('неузгоджені')
})
it('does not write stock, operations or outbox while reporting',()=>{
 sale();refund()
 const before=db.prepare('SELECT COUNT(*) n FROM sync_outbox').get()
 db.prepare('PRAGMA query_only=ON').run()
 expect(run()[0].qty_net).toBe(0)
 expect(db.prepare('SELECT COUNT(*) n FROM sync_outbox').get()).toEqual(before)
 expect(db.prepare("SELECT qty_on_hand FROM products WHERE id='p'").get()).toMatchObject({qty_on_hand:3})
 db.prepare('PRAGMA query_only=OFF').run()
})
it('keeps a read snapshot during a concurrent WAL write',()=>{
 sale()
 const writer=new LocalDatabase(root), original=db.prepare.bind(db)
 let changed=false
 vi.spyOn(db,'prepare').mockImplementation((sql:string)=>{
  if(!changed&&sql.startsWith('WITH')&&sql.endsWith('SELECT * FROM lines')){
   changed=true
   writer.prepare('UPDATE sales SET total=20000').run()
   writer.prepare('UPDATE sale_items SET total=20000').run()
  }
  return original(sql)
 })
 try{
  expect(run()[0].revenue).toBe(10000);expect(changed).toBe(true)
  expect(run()[0].revenue).toBe(20000)
 }finally{writer.close();vi.restoreAllMocks()}
})
