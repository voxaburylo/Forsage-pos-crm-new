import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'

let root: string, db: LocalDatabase, supply: LocalSupplyRepository, invoice: any
const at='2026-10-08T12:00:00.000Z'
const tables=['products','supply_invoices','supply_invoice_items','supplier_payments','cash_operations','inventory_movements','sync_outbox','app_meta']
const snapshot=()=>Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]))
beforeEach(()=>{
  root=mkdtempSync(path.join(tmpdir(),'forsage-terminal-write-'));db=new LocalDatabase(root);supply=new LocalSupplyRepository(db)
  for(const id of ['p','q']) db.prepare('INSERT INTO products(id,tenant_id,sku,name,qty_on_hand,purchase_price,created_at,updated_at) VALUES(?,?,?,?,3,20,?,?)').run(id,tenant,id,'Fixture '+id,at,at)
  invoice=supply.createInvoice({id:'invoice',items:[{id:'line-a',product_id:'p',qty:46,purchase_price:100},{id:'line-b',product_id:'q',qty:1,purchase_price:50}]})
})
afterEach(()=>{
  db.close()
  if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-terminal-write-'))rmSync(root,{recursive:true,force:true})
})
const finish=(kind:'cancel'|'delete')=>kind==='cancel'?supply.cancelInvoice(invoice.id):supply.deleteInvoice(invoice.id)
const receiptKey=()=> 'supply-terminal:'+tenant+':'+invoice.id

it('cancels a draft without touching stock, purchase prices or creating movements',()=>{
  const before=snapshot()
  expect(supply.cancelInvoice(invoice.id).status).toBe('cancelled')
  const after=snapshot()
  for(const table of ['products','supply_invoice_items','supplier_payments','cash_operations','inventory_movements']) expect(after[table]).toEqual(before[table])
  expect(JSON.parse((db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(receiptKey()) as any).value_json).movement_fingerprint).toMatch(/^[0-9a-f]{64}$/)
})
it('deletes only the draft and lines, preserving supplier provenance and stock',()=>{
  const supplier=supply.saveSupplier({name:'Supplier'}).id
  supply.updateInvoice(invoice.id,{supplier_id:supplier})
  const before=snapshot();finish('delete')
  const after=snapshot();expect(after.supply_invoices).toEqual([]);expect(after.supply_invoice_items).toEqual([])
  for(const table of ['products','supplier_payments','cash_operations','inventory_movements']) expect(after[table]).toEqual(before[table])
  for(const row of before.app_meta) expect(after.app_meta).toContainEqual(row)
})
it('reverses repeated fractional rows once and preserves current purchase price',()=>{
  supply.updateInvoice(invoice.id,{items:[{product_id:'p',qty:0.1,purchase_price:100},{product_id:'p',qty:0.2,purchase_price:200}]})
  supply.postInvoice(invoice.id)
  db.exec("UPDATE products SET purchase_price=333 WHERE id='p'")
  finish('cancel')
  expect(db.prepare("SELECT qty_on_hand,purchase_price FROM products WHERE id='p'").get()).toEqual({qty_on_hand:3,purchase_price:333})
  expect(db.prepare("SELECT qty_delta,qty_after FROM inventory_movements WHERE source_type='supply_invoice_cancel' ORDER BY rowid").all())
    .toEqual([{qty_delta:-0.1,qty_after:3.2},{qty_delta:-0.2,qty_after:3}])
  const after=snapshot();finish('cancel');expect(snapshot()).toEqual(after)
})
it('checks the total required quantity of repeated rows before cancelling',()=>{
  supply.updateInvoice(invoice.id,{items:[{product_id:'p',qty:0.1,purchase_price:100},{product_id:'p',qty:0.2,purchase_price:200}]})
  supply.postInvoice(invoice.id);db.exec("UPDATE products SET qty_on_hand=0.2 WHERE id='p'")
  const before=snapshot();expect(()=>finish('cancel')).toThrow(/вже продано/);expect(snapshot()).toEqual(before)
})
it('allows later stock and sync metadata changes on a cancelled retry after restart',()=>{
  const posted=supply.postInvoice(invoice.id);supply.cancelInvoice(invoice.id,tenant,posted.edit_revision)
  db.exec("UPDATE products SET qty_on_hand=777,purchase_price=555 WHERE id='p'")
  db.exec("UPDATE inventory_movements SET dirty_at=NULL,remote_updated_at='2026-10-09',updated_at='2026-10-09'; DELETE FROM sync_outbox")
  db.close();db=new LocalDatabase(root);supply=new LocalSupplyRepository(db)
  const before=snapshot();supply.cancelInvoice(invoice.id,tenant,posted.edit_revision);expect(snapshot()).toEqual(before)
})
it('preserves a legacy cancellation receipt without inventing a movement proof',()=>{
  supply.postInvoice(invoice.id);finish('cancel')
  const row=db.prepare('SELECT * FROM app_meta WHERE key=?').get(receiptKey()) as any, value=JSON.parse(row.value_json)
  delete value.movement_fingerprint
  db.prepare('UPDATE app_meta SET value_json=? WHERE key=?').run(JSON.stringify(value),receiptKey())
  const before=snapshot();finish('cancel');expect(snapshot()).toEqual(before)
})
it('rejects a malformed new movement proof',()=>{
  finish('cancel')
  db.prepare("UPDATE app_meta SET value_json=json_set(value_json,'$.movement_fingerprint','broken') WHERE key=?").run(receiptKey())
  const before=snapshot();expect(()=>finish('cancel')).toThrow();expect(snapshot()).toEqual(before)
})
it.each(['cancel','delete'] as const)('preserves old queue entries during %s',kind=>{
  db.exec("CREATE TRIGGER old_queue AFTER INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice."+(kind==='cancel'?'cancelled':'deleted')+"' BEGIN UPDATE sync_outbox SET payload_json='{}' WHERE operation_type='supplier_invoice.created'; END")
  const before=snapshot();expect(()=>finish(kind)).toThrow();expect(snapshot()).toEqual(before)
})
it.each(['cancel','delete'] as const)('rejects an altered receipt timestamp during %s',kind=>{
  db.exec("CREATE TRIGGER receipt_time AFTER INSERT ON app_meta WHEN NEW.key LIKE 'supply-terminal:%' BEGIN UPDATE app_meta SET updated_at='Wrong' WHERE key=NEW.key; END")
  const before=snapshot();expect(()=>finish(kind)).toThrow();expect(snapshot()).toEqual(before)
})
it.each(['cancel','delete'] as const)('rejects an extra queue entry during %s',kind=>{
  db.exec("CREATE TRIGGER extra_queue AFTER INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice."+(kind==='cancel'?'cancelled':'deleted')+"' BEGIN INSERT INTO sync_outbox(operation_id,tenant_id,device_id,aggregate_type,aggregate_id,operation_type,payload_json,created_at) VALUES('extra',NEW.tenant_id,NEW.device_id,NEW.aggregate_type,NEW.aggregate_id,'extra','{}',NEW.created_at); END")
  const before=snapshot();expect(()=>finish(kind)).toThrow();expect(snapshot()).toEqual(before)
})
it('rejects a late payment inserted while cancelling',()=>{
  supply.postInvoice(invoice.id)
  db.exec("CREATE TRIGGER late_payment AFTER INSERT ON app_meta WHEN NEW.key LIKE 'supply-terminal:%' BEGIN INSERT INTO supplier_payments(id,tenant_id,invoice_id,amount,payment_method,fund_source,created_at,updated_at) VALUES('late','"+tenant+"','invoice',100,'cash','owner_funds','"+at+"','"+at+"'); END")
  const before=snapshot();expect(()=>finish('cancel')).toThrow();expect(snapshot()).toEqual(before)
})
it('handles a 500-line cancellation, including free items',()=>{
  supply.updateInvoice(invoice.id,{items:Array.from({length:500},(_,i)=>({product_id:i%2?'p':'q',qty:0.001,purchase_price:i%3?100:0}))})
  supply.postInvoice(invoice.id);finish('cancel')
  expect(db.prepare('SELECT qty_on_hand FROM products ORDER BY id').all()).toEqual([{qty_on_hand:3},{qty_on_hand:3}])
  expect((db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE source_type='supply_invoice_cancel'").get() as any).n).toBe(500)
})
it.each(['cancel','delete'] as const)('keeps terminal retry safe after a legitimate supplier merge: %s',kind=>{
  const source=supply.saveSupplier({name:'Source'}).id,target=supply.saveSupplier({name:'Target'}).id
  supply.updateInvoice(invoice.id,{supplier_id:source})
  if(kind==='cancel') supply.postInvoice(invoice.id)
  finish(kind);supply.mergeSuppliers(target,source)
  const before=snapshot();finish(kind);expect(snapshot()).toEqual(before)
})
it.each(['first','retry'] as const)('blocks a supplier merge with damaged cancelled movements: %s',kind=>{
  const source=supply.saveSupplier({name:'Source'}).id,target=supply.saveSupplier({name:'Target'}).id
  supply.updateInvoice(invoice.id,{supplier_id:source});supply.postInvoice(invoice.id);finish('cancel')
  if(kind==='retry') supply.mergeSuppliers(target,source)
  db.exec("UPDATE inventory_movements SET qty_after=99 WHERE source_type='supply_invoice_cancel'")
  const before=snapshot();expect(()=>supply.mergeSuppliers(target,source)).toThrow();expect(snapshot()).toEqual(before)
})
it('does not merge deleted history with orphan inventory movements',()=>{
  const source=supply.saveSupplier({name:'Source'}).id,target=supply.saveSupplier({name:'Target'}).id
  supply.updateInvoice(invoice.id,{supplier_id:source});finish('delete')
  db.prepare("INSERT INTO inventory_movements(id,tenant_id,product_id,source_type,source_id,qty_delta,qty_after,created_at,updated_at) VALUES('orphan',?,'p','supply_invoice','invoice',1,1,?,?)").run(tenant,at,at)
  const before=snapshot();expect(()=>supply.mergeSuppliers(target,source)).toThrow();expect(snapshot()).toEqual(before)
})

it.each(['product','movement','header','queue','receipt'])('rolls back a skipped cancellation %s',kind=>{
  supply.postInvoice(invoice.id)
  const target=kind==='product'?"BEFORE UPDATE ON products WHEN NEW.id='q'":kind==='movement'?"BEFORE INSERT ON inventory_movements WHEN NEW.source_type='supply_invoice_cancel' AND NEW.product_id='q'"
    :kind==='header'?'BEFORE UPDATE ON supply_invoices':kind==='queue'?"BEFORE INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice.cancelled'"
    :"BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'supply-terminal:%'"
  db.exec('CREATE TRIGGER skip_cancel '+target+' BEGIN SELECT RAISE(IGNORE); END')
  const before=snapshot();expect(()=>finish('cancel')).toThrow();expect(snapshot()).toEqual(before)
  db.exec('DROP TRIGGER skip_cancel');expect(supply.cancelInvoice(invoice.id).status).toBe('cancelled')
  const after=snapshot();finish('cancel');expect(snapshot()).toEqual(after)
})
it.each(['line','header','queue','receipt'])('rolls back a skipped deletion %s',kind=>{
  const target=kind==='line'?"BEFORE DELETE ON supply_invoice_items WHEN OLD.id='line-b'":kind==='header'?'BEFORE DELETE ON supply_invoices'
    :kind==='queue'?"BEFORE INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice.deleted'":"BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'supply-terminal:%'"
  db.exec('CREATE TRIGGER skip_delete '+target+' BEGIN SELECT RAISE(IGNORE); END')
  const before=snapshot();expect(()=>finish('delete')).toThrow();expect(snapshot()).toEqual(before)
  db.exec('DROP TRIGGER skip_delete');finish('delete')
  const after=snapshot();finish('delete');expect(snapshot()).toEqual(after)
})
it.each(['stock','movement','header','late line','original movement','queue','receipt','late product'])('rejects a damaged cancellation write: %s',kind=>{
  supply.postInvoice(invoice.id)
  const trigger=kind==='stock'?"AFTER UPDATE ON products BEGIN UPDATE products SET qty_on_hand=99 WHERE id=NEW.id; END"
    :kind==='movement'?"AFTER INSERT ON inventory_movements WHEN NEW.source_type='supply_invoice_cancel' BEGIN UPDATE inventory_movements SET qty_delta=qty_delta-1 WHERE id=NEW.id; END"
    :kind==='header'?"AFTER UPDATE ON supply_invoices BEGIN UPDATE supply_invoices SET notes='Wrong' WHERE id=NEW.id; END"
    :kind==='queue'?"AFTER INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice.cancelled' BEGIN UPDATE sync_outbox SET payload_json='{}' WHERE operation_id=NEW.operation_id; END"
    :"AFTER INSERT ON app_meta WHEN NEW.key LIKE 'supply-terminal:%' BEGIN "+(kind==='late line'?"UPDATE supply_invoice_items SET qty=23,purchase_price=200 WHERE id='line-a'"
      :kind==='original movement'?"DELETE FROM inventory_movements WHERE source_type='supply_invoice'"
      :kind==='receipt'?"UPDATE app_meta SET value_json='{}' WHERE key=NEW.key":"UPDATE products SET name='Wrong' WHERE id='p'")+'; END'
  db.exec('CREATE TRIGGER alter_cancel '+trigger)
  const before=snapshot();expect(()=>finish('cancel')).toThrow();expect(snapshot()).toEqual(before)
})
it.each(['queue','receipt','stock','provenance','resurrected header'])('rejects a damaged deletion write: %s',kind=>{
  const trigger=kind==='queue'?"AFTER INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice.deleted' BEGIN UPDATE sync_outbox SET payload_json='{}' WHERE operation_id=NEW.operation_id; END"
    :"AFTER INSERT ON app_meta WHEN NEW.key LIKE 'supply-terminal:%' BEGIN "+(kind==='receipt'?"UPDATE app_meta SET value_json='{}' WHERE key=NEW.key"
      :kind==='stock'?"UPDATE products SET qty_on_hand=99 WHERE id='p'"
      :kind==='provenance'?"INSERT INTO app_meta(key,value_json,updated_at) VALUES('invoice-supplier-changes:"+tenant+":invoice','[]','"+at+"')"
      :"INSERT INTO supply_invoices(id,tenant_id,status,total,created_at,updated_at) VALUES('invoice','"+tenant+"','draft',0,'"+at+"','"+at+"')")+'; END'
  db.exec('CREATE TRIGGER alter_delete '+trigger)
  const before=snapshot();expect(()=>finish('delete')).toThrow();expect(snapshot()).toEqual(before)
})
it.each(['cancel','delete'] as const)('does not %s a draft with orphan stock movements',kind=>{
  db.prepare("INSERT INTO inventory_movements(id,tenant_id,product_id,source_type,source_id,qty_delta,qty_after,created_at,updated_at) VALUES('orphan',?,'p','supply_invoice','invoice',46,49,?,?)").run(tenant,at,at)
  const before=snapshot();expect(()=>finish(kind)).toThrow();expect(snapshot()).toEqual(before)
})
it.each(['missing','foreign','quantity','reversal'])('refuses cancellation with damaged original movements: %s',kind=>{
  supply.postInvoice(invoice.id)
  if(kind==='missing') db.exec("DELETE FROM inventory_movements WHERE product_id='q'")
  if(kind==='foreign') db.exec("UPDATE inventory_movements SET tenant_id='foreign' WHERE product_id='q'")
  if(kind==='quantity') db.exec("UPDATE inventory_movements SET qty_delta=2 WHERE product_id='q'")
  if(kind==='reversal') db.exec("UPDATE inventory_movements SET source_type='supply_invoice_cancel' WHERE product_id='q'")
  const before=snapshot();expect(()=>finish('cancel')).toThrow();expect(snapshot()).toEqual(before)
})
it.each(['line','payment','movement'])('rejects a deleted retry with orphan %s',kind=>{
  finish('delete');db.exec('PRAGMA foreign_keys=OFF')
  if(kind==='line') db.prepare("INSERT INTO supply_invoice_items(id,tenant_id,invoice_id,product_id,qty,purchase_price,total,created_at,updated_at) VALUES('orphan',?,'invoice','p',1,100,100,?,?)").run(tenant,at,at)
  if(kind==='payment') db.prepare("INSERT INTO supplier_payments(id,tenant_id,invoice_id,amount,payment_method,fund_source,created_at,updated_at) VALUES('orphan',?,'invoice',100,'cash','owner_funds',?,?)").run(tenant,at,at)
  if(kind==='movement') db.prepare("INSERT INTO inventory_movements(id,tenant_id,product_id,source_type,source_id,qty_delta,qty_after,created_at,updated_at) VALUES('orphan',?,'p','supply_invoice','invoice',1,1,?,?)").run(tenant,at,at)
  const before=snapshot();expect(()=>finish('delete')).toThrow();expect(snapshot()).toEqual(before)
})
it.each(['remove','amount','position','foreign'])('does not acknowledge a cancelled retry with damaged movement %s',kind=>{
  supply.postInvoice(invoice.id);finish('cancel')
  if(kind==='remove') db.exec("DELETE FROM inventory_movements WHERE source_type='supply_invoice_cancel' AND product_id='p'")
  if(kind==='amount') db.exec("UPDATE inventory_movements SET qty_delta=-2 WHERE source_type='supply_invoice_cancel' AND product_id='q'")
  if(kind==='position') db.exec("UPDATE inventory_movements SET qty_after=999 WHERE source_type='supply_invoice_cancel' AND product_id='q'")
  if(kind==='foreign') db.exec("UPDATE inventory_movements SET tenant_id='foreign' WHERE source_type='supply_invoice_cancel' AND product_id='q'")
  const before=snapshot();expect(()=>finish('cancel')).toThrow();expect(snapshot()).toEqual(before)
})
