import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
let root:string, db:LocalDatabase, orders:LocalOrderRepository
const manager=randomUUID(), body=()=>({manager_id:manager,tenant_id:tenant,operation_id:randomUUID(),items:[{name:'Тестовий фільтр',sku:'TEST',qty:2,sell_price:12000,source_type:'supplier'}]})
beforeEach(()=>{root=mkdtempSync(path.join(tmpdir(),'forsage-order-save-test-'));db=new LocalDatabase(root);orders=new LocalOrderRepository(db)})
afterEach(()=>{db.close();if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-order-save-test-'))rmSync(root,{recursive:true,force:true})})
const count=(table:string)=>Number((db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n)
it('recovers a create after restart without writing or reserving twice',()=>{
  const input=body(), first=orders.saveOrder(input), outbox=count('sync_outbox')
  db.close();db=new LocalDatabase(root);orders=new LocalOrderRepository(db)
  expect(orders.getSaveResult(input.operation_id,manager,tenant).id).toBe(first.id)
  expect(orders.saveOrder(input).id).toBe(first.id)
  expect(count('customer_orders')).toBe(1);expect(count('sync_outbox')).toBe(outbox)
  expect(()=>orders.saveOrder({...input,comment:'інший запит'})).toThrow(/інші дані/)
})
it('acknowledges an update before checking its now-old version, without replacing lines twice',()=>{
  const first=orders.saveOrder(body()), input={...body(),expected_updated_at:first.updated_at,items:[{...first.items[0],qty:3}]}
  const updated=orders.saveOrder(input,first.id), outbox=count('sync_outbox')
  expect(orders.saveOrder(input,first.id).updated_at).toBe(updated.updated_at)
  expect(orders.getSaveResult(input.operation_id,manager,tenant,first.id).items[0].qty).toBe(3)
  expect(count('customer_order_items')).toBe(1);expect(count('sync_outbox')).toBe(outbox)
  expect(()=>orders.saveOrder({...input,operation_id:randomUUID()},first.id)).toThrow(/вже змінено/)
})
it('isolates employee/shop receipts and distinguishes deleted orders from absent writes',()=>{
  const input=body(), first=orders.saveOrder(input)
  expect(()=>orders.getSaveResult(input.operation_id,randomUUID(),tenant)).toThrow(/іншому працівнику/)
  expect(orders.getSaveResult(input.operation_id,manager,randomUUID())).toBeNull()
  expect(orders.getSaveResult(randomUUID(),manager,tenant)).toBeNull()
  orders.deleteOrder(first.id,tenant)
  expect(()=>orders.getSaveResult(input.operation_id,manager,tenant)).toThrow(/видалене/)
})
it('does not persist a receipt when the transaction rolls back',()=>{
  const input={...body(),items:[{name:'Неправильна кількість',qty:-1,sell_price:100}]}
  expect(()=>orders.saveOrder(input)).toThrow()
  expect(orders.getSaveResult(input.operation_id,manager,tenant)).toBeNull()
  expect(count('customer_orders')).toBe(0)
})
