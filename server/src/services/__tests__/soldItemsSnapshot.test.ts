import { PGlite } from '@electric-sql/pglite'
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest'
const state = vi.hoisted(()=>({db:null as any,calls:0,fail:false}))
vi.mock('../../db/pg.js',()=>({pool:{query:async(sql:string,args:unknown[])=>{
  state.calls++; if(state.fail)throw Error('offline'); return state.db.query(sql,args)
}}}))
import { getSoldItems } from '../soldItemsReport.js'
const day='2026-10-04', at=day+'T10:00:00Z'
const run=(from=day,to=from)=>getSoldItems(from,to,'shop')
beforeAll(async()=>{
 state.db=new PGlite()
 await state.db.exec(`
 CREATE SCHEMA auth;
 CREATE TABLE auth.users(id text PRIMARY KEY,raw_app_meta_data jsonb,raw_user_meta_data jsonb);
 CREATE TABLE sales(id text PRIMARY KEY,tenant_id text,total int,status text,completed_at timestamptz,created_at timestamptz,manager_id text,cashier_id text,deleted_at timestamptz);
 CREATE TABLE sale_items(id text PRIMARY KEY,tenant_id text,sale_id text,product_id text,qty numeric,total int,core_deposit_amount int,deleted_at timestamptz);
 CREATE TABLE customer_orders(id text PRIMARY KEY,tenant_id text,sale_id text,manager_id text,deleted_at timestamptz);
 CREATE TABLE returns(id text PRIMARY KEY,tenant_id text,sale_id text,status text,created_at timestamptz,refund_kopecks int,refund_amount int,deleted_at timestamptz);
 CREATE TABLE return_items(id text PRIMARY KEY,tenant_id text,return_id text,sale_item_id text,product_id text,quantity numeric,total_kopecks int,deleted_at timestamptz);
 CREATE TABLE products(id text PRIMARY KEY,tenant_id text,sku text,barcode text,name text,unit text,qty_on_hand numeric,storage_bin text,is_service boolean,deleted_at timestamptz);
 CREATE TABLE product_barcodes(id text PRIMARY KEY,tenant_id text,product_id text,barcode text,is_primary boolean,created_at timestamptz,deleted_at timestamptz);
 CREATE TABLE suppliers(id text PRIMARY KEY,tenant_id text,name text,deleted_at timestamptz);
 CREATE TABLE supply_invoices(id text PRIMARY KEY,tenant_id text,supplier_id text,status text,deleted_at timestamptz);
 CREATE TABLE supply_invoice_items(id text PRIMARY KEY,tenant_id text,invoice_id text,product_id text,qty numeric,deleted_at timestamptz);
 `)
},30000)
afterAll(async()=>state.db?.close())
beforeEach(async()=>{
 await state.db.exec('TRUNCATE auth.users,sales,sale_items,customer_orders,returns,return_items,products,product_barcodes,suppliers,supply_invoices,supply_invoice_items')
 state.calls=0;state.fail=false
 await state.db.exec(`INSERT INTO products VALUES('p','shop','WA9428',NULL,'Фільтр WIX WA9428','шт',3,'A',false,NULL);
 INSERT INTO auth.users VALUES('seller','{"tenant_id":"shop"}','{"full_name":"Касир"}');`)
})
async function sale(id='s',options:{at?:string,total?:number,qty?:number,manager?:string|null,product?:string|null,tenant?:string,status?:string}={}){
 const {at:time=at,total=10000,qty=1,manager=null,product='p',tenant='shop',status='completed'}=options
 await state.db.query('INSERT INTO sales VALUES($1,$2,$3,$4,$5,$5,$6,$7,NULL)',[id,tenant,total,status,time,manager,'seller'])
 await state.db.query('INSERT INTO sale_items VALUES($1,$2,$3,$4,$5,$6,0,NULL)',[id,tenant,id,product,qty,total])
}
async function refund(id='r',source='s',options:{at?:string,qty?:number,amount?:number,status?:string}={}){
 const {at:time=at,qty=1,amount=10000,status='completed'}=options
 await state.db.query('INSERT INTO returns VALUES($1,$2,$3,$4,$5,$6,$6,NULL)',[id,'shop',source,status,time,amount])
 await state.db.query('INSERT INTO return_items VALUES($1,$2,$3,$4,$5,$6,$7,NULL)',[id,'shop',id,source,'p',qty,amount])
}
it('reads exactly one snapshot and allocates receipt discounts before excluding services/free-price lines',async()=>{
 await sale('s',{total:27000,qty:2})
 await state.db.exec(`UPDATE sale_items SET total=20000;
 INSERT INTO products VALUES('service','shop','','','Послуга','шт',0,NULL,true,NULL);
 INSERT INTO sale_items VALUES('service','shop','s','service',1,5000,0,NULL),('free','shop','s',NULL,1,5000,0,NULL);`)
 await refund('r','s',{amount:9000})
 expect(await run()).toEqual([expect.objectContaining({qty_sold:2,qty_returned:1,qty_net:1,revenue:18000,refund_total:9000,net_revenue:9000,
 sellers:[expect.objectContaining({id:'seller',name:'Касир',net_revenue:9000})]})])
 expect(state.calls).toBe(1)
})
it('does not rewrite yesterday when the refund was made today',async()=>{
 await sale('s',{at:'2026-10-03T10:00:00Z',status:'returned'});await refund()
 expect((await run('2026-10-03'))[0]).toMatchObject({qty_net:1,net_revenue:10000,qty_returned:0})
 expect((await run())[0]).toMatchObject({qty_sold:0,qty_returned:1,qty_net:-1,revenue:0,net_revenue:-10000})
 expect((await run('2026-10-03',day))[0]).toMatchObject({qty_net:0,net_revenue:0})
})
it('does not include future returns or drafts',async()=>{
 await sale();await refund('future','s',{at:'2026-10-05T10:00:00Z'});await refund('draft','s',{status:'draft'})
 expect((await run())[0]).toMatchObject({qty_returned:0,net_revenue:10000})
})
it('keeps exact fractional quantity and each seller subtotal',async()=>{
 for(let i=0;i<10;i++)await sale('s'+i,{total:1,qty:.1,manager:i%2?'one':'two'})
 const row=(await run())[0]
 expect(row.qty_sold).toBe(1);expect(row.revenue).toBe(10)
 expect(row.sellers.map((s:any)=>s.qty_sold)).toEqual([.5,.5])
})
it('uses the saved manager ahead of current order manager, including for a later return',async()=>{
 await sale('s',{manager:'original',at:'2026-10-03T10:00:00Z'});await refund()
 await state.db.exec("INSERT INTO customer_orders VALUES('o','shop','s','replacement',NULL)")
 expect((await run())[0].sellers[0].id).toBe('original')
})
it('uses legacy order manager then cashier; preserves unknown and archived identities',async()=>{
 await sale()
 await state.db.exec("INSERT INTO customer_orders VALUES('o','shop','s','manager',NULL)")
 expect((await run())[0].sellers[0]).toMatchObject({id:'manager',name:'Невідомий працівник'})
 await state.db.exec("UPDATE sales SET manager_id='seller'; UPDATE auth.users SET raw_app_meta_data=raw_app_meta_data||'{\"deleted_at\":\"gone\"}'::jsonb")
 expect((await run())[0].sellers[0].name).toBe('Касир')
})
it('does not accept editable profile tenant metadata as authority',async()=>{
 await sale();await state.db.exec(`UPDATE auth.users SET raw_app_meta_data='{"tenant_id":"other"}',raw_user_meta_data='{"tenant_id":"shop","full_name":"Чуже"}'`)
 expect((await run())[0].sellers[0].name).toBe('Невідомий працівник')
})
it('rejects duplicated order links instead of multiplying receipt revenue',async()=>{
 await sale();await state.db.exec("INSERT INTO customer_orders VALUES('o','shop','s',NULL,NULL),('o2','shop','s',NULL,NULL)")
 await expect(run()).rejects.toMatchObject({code:'INCOMPLETE_REPORT'})
})
it.each(['2026-02-30','2026-13-01','2026-2-01','','9999-01-01'])('rejects invalid date %s',async value=>{
 await expect(run(value)).rejects.toMatchObject({code:'VALIDATION_ERROR'});expect(state.calls).toBe(0)
})
it('rejects a reversed period',async()=>{await expect(run(day,'2026-10-03')).rejects.toMatchObject({code:'VALIDATION_ERROR'})})
it.each([
 ['2026-10-03T20:59:59.999Z',0],['2026-10-03T21:00:00Z',1],
 ['2026-10-04T20:59:59.999Z',1],['2026-10-04T21:00:00Z',0],
] as const)('respects Kyiv date boundary %s',async(time,count)=>{
 await sale('s',{at:time});expect(await run()).toHaveLength(count)
})
it('respects the 25-hour Kyiv DST transition day',async()=>{
 await sale('before',{at:'2026-10-24T20:59:59.999Z'});await sale('start',{at:'2026-10-24T21:00:00Z'})
 await sale('end',{at:'2026-10-25T21:59:59.999Z'});await sale('after',{at:'2026-10-25T22:00:00Z'})
 expect((await run('2026-10-25'))[0].qty_sold).toBe(2)
})
it('counts archived goods and alias barcode, but no alien sales/products/metadata',async()=>{
 await sale();await sale('other',{tenant:'other',total:99999})
 await state.db.exec(`UPDATE products SET deleted_at=now();
 INSERT INTO product_barcodes VALUES('b','shop','p','123',true,now(),NULL),('alien','other','p','SECRET',true,now(),NULL);`)
 expect((await run())[0]).toMatchObject({revenue:10000,barcode:'123'})
})
it('keeps several suppliers without multiplying totals',async()=>{
 await sale()
 await state.db.exec(`INSERT INTO suppliers VALUES('a','shop','Автокомфорт',NULL),('b','shop','Другий',NULL),('c','other','Чужий',NULL);
 INSERT INTO supply_invoices VALUES('i','shop','a','posted',NULL),('i2','shop','a','posted',NULL),('i3','shop','b','posted',NULL),
 ('draft','shop','b','draft',NULL),('alien','shop','c','posted',NULL);
 INSERT INTO supply_invoice_items VALUES('l','shop','i','p',1,NULL),('l2','shop','i2','p',1,NULL),
 ('l3','shop','i3','p',1,NULL),('bad','shop','alien','p',1,NULL);`)
 expect((await run())[0]).toMatchObject({qty_net:1,revenue:10000,suppliers:[{id:'a',name:'Автокомфорт'},{id:'b',name:'Другий'}]})
})
it('reads more than the API 1000-row limit without partial totals',async()=>{
 await state.db.exec(`INSERT INTO sales SELECT 's'||n,'shop',1,'completed','2026-10-04T10:00:00Z','2026-10-04T10:00:00Z',NULL,'seller',NULL FROM generate_series(1,1205)n;
 INSERT INTO sale_items SELECT 's'||n,'shop','s'||n,'p',1,1,0,NULL FROM generate_series(1,1205)n;`)
 expect((await run())[0]).toMatchObject({qty_sold:1205,revenue:1205});expect(state.calls).toBe(1)
})
it.each([
 'DELETE FROM sale_items','UPDATE sale_items SET qty=0','UPDATE sale_items SET total=-1',
 'UPDATE sales SET total=10001',"UPDATE products SET tenant_id='other'",
 'UPDATE sale_items SET qty=0.0001','UPDATE sales SET total=NULL',
])('rejects incomplete or inconsistent sale: %s',async sql=>{
 await sale();await state.db.exec(sql.replaceAll("\\'","'"));await expect(run()).rejects.toMatchObject({code:'INCOMPLETE_REPORT'})
})
it.each([
 'DELETE FROM return_items','UPDATE return_items SET quantity=2','UPDATE return_items SET product_id=NULL',
 "UPDATE return_items SET sale_item_id='missing'",'UPDATE returns SET refund_kopecks=9999',
 "UPDATE sales SET status='cancelled'","UPDATE return_items SET tenant_id='other'",
])('rejects incomplete or inconsistent refund: %s',async sql=>{
 await sale();await refund();await state.db.exec(sql);await expect(run()).rejects.toMatchObject({code:'INCOMPLETE_REPORT'})
})
it('preserves zero-priced sales and core deposits',async()=>{
 await sale('s',{total:50});await state.db.exec("UPDATE sale_items SET total=200,core_deposit_amount=100")
 expect((await run())[0].revenue).toBe(50)
 await state.db.exec("UPDATE sales SET total=0");expect((await run())[0].revenue).toBe(0)
})

it.each([
 "UPDATE supply_invoice_items SET deleted_at=now()","UPDATE supply_invoice_items SET tenant_id='other'",
 "UPDATE supply_invoice_items SET qty=0","UPDATE supply_invoices SET status='draft'",
 "UPDATE supply_invoices SET deleted_at=now()","UPDATE supply_invoices SET tenant_id='other'",
 "UPDATE suppliers SET deleted_at=now()","UPDATE suppliers SET tenant_id='other'",
])('excludes invalid supplier history: %s',async sql=>{
 await sale()
 await state.db.exec(`INSERT INTO suppliers VALUES('a','shop','Автокомфорт',NULL);
 INSERT INTO supply_invoices VALUES('i','shop','a','posted',NULL);
 INSERT INTO supply_invoice_items VALUES('l','shop','i','p',1,NULL);`)
 await state.db.exec(sql)
 expect((await run())[0]).toMatchObject({qty_sold:1,revenue:10000,suppliers:[]})
})

it('propagates read failure, never a successful empty report',async()=>{
 state.fail=true;await expect(run()).rejects.toThrow('offline')
})
