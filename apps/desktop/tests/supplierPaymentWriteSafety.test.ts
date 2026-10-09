import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'

let root: string, db: LocalDatabase, supply: LocalSupplyRepository, invoice: any
const at='2026-10-08T06:00:00.000Z'
const payment = {payment_id:'pay',amount:75,payment_method:'cash' as const,fund_source:'cashbox' as const,shift_id:'shift',user_id:'owner',note:'Доплата'}
const snap=()=>Object.fromEntries(['supply_invoices','supply_invoice_items','supplier_payments','cash_operations','products','shifts','sync_outbox','app_meta']
  .map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]))
beforeEach(()=>{
  root=mkdtempSync(path.join(tmpdir(),'forsage-payment-write-'));db=new LocalDatabase(root);supply=new LocalSupplyRepository(db)
  db.prepare('INSERT INTO products(id,tenant_id,sku,name,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('p',tenant,'TEST','Fixture',at,at)
  db.prepare('INSERT INTO shifts(id,tenant_id,cashier_id,opening_cash,opened_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('shift',tenant,'owner',1000,at,at,at)
  const supplier=supply.saveSupplier({name:'Fixture'}).id
  invoice=supply.createInvoice({supplier_id:supplier,items:[{product_id:'p',qty:2,purchase_price:100}]})
})
afterEach(()=>{
  vi.useRealTimers()
  db.close()
  if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-payment-write-'))rmSync(root,{recursive:true,force:true})
})

it.each(['cash missing','cash duplicate','cash amount','cash actor','cash note','cash deleted','header paid','payment supplier'])('refuses damaged local payment retry: %s', kind=>{
  supply.payInvoice(invoice.id,payment)
  if(kind==='cash missing') db.exec('DELETE FROM cash_operations')
  if(kind==='cash duplicate') db.exec("INSERT INTO cash_operations (id,tenant_id,shift_id,user_id,type,source,amount,sale_id,supplier_id,employee_id,notes,remote_updated_at,dirty_at,created_at,updated_at,deleted_at) SELECT 'duplicate',tenant_id,shift_id,user_id,type,source,amount,sale_id,supplier_id,employee_id,notes,remote_updated_at,dirty_at,created_at,updated_at,deleted_at FROM cash_operations")
  if(kind==='cash amount') db.exec('UPDATE cash_operations SET amount=74')
  if(kind==='cash actor') db.exec("UPDATE cash_operations SET user_id='other'")
  if(kind==='cash note') db.exec("UPDATE cash_operations SET notes='Other'")
  if(kind==='cash deleted') db.prepare('UPDATE cash_operations SET deleted_at=?').run(at)
  if(kind==='header paid') db.exec('UPDATE supply_invoices SET paid_amount=0')
  if(kind==='payment supplier') db.exec('UPDATE supplier_payments SET supplier_id=NULL')
  const before=snap();expect(()=>supply.payInvoice(invoice.id,payment)).toThrow();expect(snap()).toEqual(before)
})
it('requires a separate cash row for identical payments made at the same instant', ()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date(at))
  const first={...payment,amount:25},second={...first,payment_id:'second'}
  supply.payInvoice(invoice.id,first);supply.payInvoice(invoice.id,second)
  supply.payInvoice(invoice.id,first);supply.payInvoice(invoice.id,second)
  db.exec('DELETE FROM cash_operations WHERE rowid=(SELECT min(rowid) FROM cash_operations)')
  const before=snap();expect(()=>supply.payInvoice(invoice.id,first)).toThrow();expect(snap()).toEqual(before)
})
it('acknowledges a closed-shift retry after restart and queue cleanup without new cash or stock', ()=>{
  supply.payInvoice(invoice.id,payment)
  db.prepare('UPDATE shifts SET closed_at=?').run(at)
  db.exec('DELETE FROM sync_outbox');db.close();db=new LocalDatabase(root);supply=new LocalSupplyRepository(db)
  const before=snap();expect(supply.payInvoice(invoice.id,payment).paid_amount).toBe(75);expect(snap()).toEqual(before)
})
it.each(['owner_funds','bank_account','business_card'] as const)('keeps local cash unchanged for %s and retries once', source=>{
  const p={...payment,fund_source:source,payment_method:source==='owner_funds'?'cash' as const:'card' as const,shift_id:null}
  const cash=db.prepare('SELECT * FROM cash_operations').all(),stock=db.prepare('SELECT * FROM products').all()
  expect(supply.payInvoice(invoice.id,p).paid_amount).toBe(75)
  const before=snap();supply.payInvoice(invoice.id,p);expect(snap()).toEqual(before)
  expect(db.prepare('SELECT * FROM cash_operations').all()).toEqual(cash);expect(db.prepare('SELECT * FROM products').all()).toEqual(stock)
})
it.each(['supplier_payments','cash_operations'])('rolls back initial payment when %s silently skips insertion',table=>{
  db.exec('CREATE TRIGGER skip_initial BEFORE INSERT ON '+table+' BEGIN SELECT RAISE(IGNORE); END')
  const before=snap()
  expect(()=>supply.createInvoice({paid_amount:75,payment_method:'cash',fund_source:'cashbox',shift_id:'shift',user_id:'owner',items:[{product_id:'p',qty:2,purchase_price:100}]})).toThrow()
  expect(snap()).toEqual(before)
})
it.each(['supplier_payments','cash_operations'])('rejects an initial payment changed by the final queue write: %s',table=>{
  db.exec('CREATE TRIGGER alter_initial AFTER INSERT ON sync_outbox BEGIN UPDATE '+table+' SET amount=amount+1; END')
  const before=snap()
  expect(()=>supply.createInvoice({paid_amount:75,payment_method:'cash',fund_source:'cashbox',shift_id:'shift',user_id:'owner',items:[{product_id:'p',qty:2,purchase_price:100}]})).toThrow()
  expect(snap()).toEqual(before)
})
it.each(['method','source'])('rejects an invalid local payment %s',kind=>{
  const p={...payment,...(kind==='method'?{payment_method:'debt'}:{fund_source:'unknown'})} as any
  const before=snap();expect(()=>supply.payInvoice(invoice.id,p)).toThrow();expect(snap()).toEqual(before)
})

it.each(['supplier_payments','supply_invoices','cash_operations','sync_outbox'])('rolls back a silently skipped local payment write to %s', table=>{
  const verb=table==='supply_invoices'?'UPDATE':'INSERT'
  db.exec('CREATE TRIGGER skip_payment BEFORE '+verb+' ON '+table+' BEGIN SELECT RAISE(IGNORE); END')
  const before=snap();expect(()=>supply.payInvoice(invoice.id,payment)).toThrow();expect(snap()).toEqual(before)
  db.exec('DROP TRIGGER skip_payment');expect(supply.payInvoice(invoice.id,payment).paid_amount).toBe(75)
  const after=snap();supply.payInvoice(invoice.id,payment);expect(snap()).toEqual(after)
})
it.each(['payment','cash','invoice','lines','queue','late cash'])('rejects wrong persisted local payment %s', kind=>{
  const trigger=kind==='payment'?"AFTER INSERT ON supplier_payments BEGIN UPDATE supplier_payments SET note='Wrong' WHERE id=NEW.id; END"
    :kind==='cash'?"AFTER INSERT ON cash_operations BEGIN UPDATE cash_operations SET amount=amount+1 WHERE id=NEW.id; END"
    :kind==='invoice'?"AFTER UPDATE OF paid_amount ON supply_invoices BEGIN UPDATE supply_invoices SET notes='Wrong' WHERE id=NEW.id; END"
    :kind==='lines'?"AFTER UPDATE OF paid_amount ON supply_invoices BEGIN UPDATE supply_invoice_items SET qty=1,purchase_price=200 WHERE invoice_id=NEW.id; END"
    :kind==='queue'?"AFTER INSERT ON sync_outbox BEGIN UPDATE sync_outbox SET payload_json='{}' WHERE operation_id=NEW.operation_id; END"
    :"AFTER INSERT ON sync_outbox BEGIN UPDATE cash_operations SET amount=amount+1 WHERE type='supplier_payment'; END"
  db.exec('CREATE TRIGGER alter_payment '+trigger)
  const before=snap();expect(()=>supply.payInvoice(invoice.id,payment)).toThrow();expect(snap()).toEqual(before)
  db.exec('DROP TRIGGER alter_payment');supply.payInvoice(invoice.id,payment)
})
