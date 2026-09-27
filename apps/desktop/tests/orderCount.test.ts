import { randomUUID } from 'node:crypto'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
let root:string,db:LocalDatabase,repo:LocalOrderRepository
beforeEach(()=>{root=mkdtempSync(path.join(tmpdir(),'forsage-count-test-'));db=new LocalDatabase(root);repo=new LocalOrderRepository(db)})
afterEach(()=>{db.close();if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-count-test-'))rmSync(root,{recursive:true,force:true})})
it('counts only requested shop/status without loading order lines or deleted orders',()=>{
  const insert=db.prepare('INSERT INTO customer_orders(id,tenant_id,status,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?)')
  for(const [tenant,status,deleted] of [[DEFAULT_TENANT_ID,'ordered',null],[DEFAULT_TENANT_ID,'ready',null],[DEFAULT_TENANT_ID,'completed',null],[DEFAULT_TENANT_ID,'ready','2026-01-01'],[randomUUID(),'ready',null]])insert.run(randomUUID(),tenant,status,'2026-01-01','2026-01-01',deleted)
  const prepare=vi.spyOn(db,'prepare')
  expect(repo.countOrders({statuses:['ordered','ready','ordered']})).toBe(2)
  expect(prepare).toHaveBeenCalledTimes(1);expect(prepare.mock.calls[0][0]).not.toMatch(/customer_order_items|JOIN/)
  expect(repo.countOrders({statuses:[]})).toBe(0)
  expect(()=>repo.countOrders({statuses:["ready');DELETE FROM products;--"]})).toThrow()
})
it('returns the full count above the list pagination limit',()=>{
  const insert=db.prepare('INSERT INTO customer_orders(id,tenant_id,status,created_at,updated_at) VALUES(?,?,?,?,?)')
  db.transaction(()=>{for(let i=0;i<1200;i++)insert.run(randomUUID(),DEFAULT_TENANT_ID,i<1100?'ready':'completed','2026-01-01','2026-01-01')})
  expect(repo.countOrders({statuses:['ready']})).toBe(1100)
  expect(repo.listOrders({status:'ready',limit:500})).toHaveLength(500)
})
