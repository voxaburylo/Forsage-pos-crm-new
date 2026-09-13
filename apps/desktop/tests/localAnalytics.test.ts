import { expect,it } from 'vitest'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { localAnalytics } from '../src/repositories/localAnalytics'
it('runs both analytics locally and includes unsold active products in ABC',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'forsage-analytics-test-'));const db=new LocalDatabase(root)
 try {new LocalCatalogRepository(db).saveProduct({id:'abc-test',sku:'abc-test',name:'Фільтр',qty_on_hand:5});const input={kind:'abc' as const,from:'2026-01-01T00:00:00Z',to:'2026-12-31T23:59:59Z',startDate:'2026-01-01',endDate:'2026-12-31'};expect(localAnalytics(db,input).find(p=>p.id==='abc-test')).toMatchObject({abc_class:'Z',soldQty:0,currentStock:5});expect(()=>localAnalytics(db,{...input,kind:'staff'})).not.toThrow()}
 finally {db.close();if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-analytics-test-'))rmSync(root,{recursive:true,force:true})}
})

it('allocates discounts, subtracts refunds and does not charge salary advances twice',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'forsage-analytics-test-'));const db=new LocalDatabase(root)
 try {
  const tenant=DEFAULT_TENANT_ID,ts='2026-09-13T12:00:00.000Z'
  const p=new LocalCatalogRepository(db).saveProduct({id:'p',sku:'p',name:'Товар',qty_on_hand:10,purchase_price:99000})
  db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('worker',tenant,'Працівник','cashier',ts,ts)
  const shift = new LocalPosRepository(db).openShift({cashier_id:'worker'})
  db.prepare("INSERT INTO sales(id,tenant_id,sale_number,cashier_id,shift_id,status,total,payment_method,completed_at,created_at,updated_at) VALUES (?,?,? ,?,?,'completed',18000,'cash',?,?,?)").run('sale',tenant,'1','worker',shift,ts,ts,ts)
  db.prepare('INSERT INTO sale_items(id,tenant_id,sale_id,product_id,qty,unit_price,purchase_price,total,created_at,updated_at) VALUES (?,?,?,?,2,10000,5000,20000,?,?)').run('line',tenant,'sale',p.id,ts,ts)
  db.prepare("INSERT INTO customer_returns(id,tenant_id,sale_id,reason,refund_method,refund_kopecks,stock_action,created_at,updated_at) VALUES (?,?,?,'other','cash',9000,'return',?,?)").run('return',tenant,'sale',ts,ts)
  db.prepare("INSERT INTO customer_return_items(id,tenant_id,return_id,sale_item_id,product_id,quantity,unit_price_kopecks,total_kopecks,condition,created_at,updated_at) VALUES (?,?,?,?,?,1,9000,9000,'new',?,?)").run('ri',tenant,'return','line',p.id,ts,ts)
  for(const [type,amount] of [['salary',1000],['advance',600]] as const)db.prepare("INSERT INTO salary_payments(id,tenant_id,employee_id,employee_name,amount,type,method,period,work_date,created_at,updated_at) VALUES (?,?,?,'Тест',?,?,'cash','2026-09','2026-09-13',?,?)").run(type,tenant,'worker',amount,type,ts,ts)
  const input={kind:'abc' as const,from:'2026-09-13T00:00:00.000Z',to:'2026-09-13T23:59:59.999Z',startDate:'2026-09-13',endDate:'2026-09-13'}
  expect(localAnalytics(db,input).find(r=>r.id===p.id)).toMatchObject({soldQty:1,profit:4000})
  expect(localAnalytics(db,{...input,kind:'staff'}).find(r=>r.manager_id==='worker')).toMatchObject({gross_profit:4000,total_payouts:600,net_profit:3000})
 }finally{db.close();if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-analytics-test-'))rmSync(root,{recursive:true,force:true})}
})
