import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import { commitReceiving } from '../src/repositories/receivingCommit'

let root: string, db: LocalDatabase, supply: LocalSupplyRepository, invoice: any
const at='2026-10-08T12:00:00.000Z'
const tables=['products','supply_invoices','supply_invoice_items','supplier_payments','cash_operations','inventory_movements','sync_outbox','app_meta']
const snapshot=()=>Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]))
const edit=()=>supply.updateInvoice(invoice.id,{notes:'Corrected',items:[{id:'new-a',product_id:'p',qty:98,purchase_price:100},{id:'new-b',product_id:'q',qty:2,purchase_price:50}]})
beforeEach(()=>{
  root=mkdtempSync(path.join(tmpdir(),'forsage-supply-write-'));db=new LocalDatabase(root);supply=new LocalSupplyRepository(db)
  for(const id of ['p','q']) db.prepare('INSERT INTO products(id,tenant_id,sku,name,qty_on_hand,purchase_price,created_at,updated_at) VALUES(?,?,?,?,3,20,?,?)').run(id,tenant,id,'Fixture '+id,at,at)
  for(const id of ['supplier','other']) db.prepare('INSERT INTO suppliers(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,tenant,id,at,at)
  db.prepare('INSERT INTO shifts(id,tenant_id,cashier_id,opening_cash,opened_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('shift',tenant,'owner',10000,at,at,at)
  invoice=supply.createInvoice({id:'invoice',supplier_id:'supplier',items:[{id:'old-a',product_id:'p',qty:46,purchase_price:100},{id:'old-b',product_id:'q',qty:1,purchase_price:50}]})
})
afterEach(()=>{
  db.close()
  if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-supply-write-'))rmSync(root,{recursive:true,force:true})
})

it('edits header only without changing line identity, stock, payments or cash',()=>{
  supply.payInvoice(invoice.id,{amount:75,payment_method:'cash',fund_source:'cashbox',shift_id:'shift',user_id:'owner'})
  const before=snapshot(), saved=supply.updateInvoice(invoice.id,{notes:'Header only'})
  expect(saved.notes).toBe('Header only')
  const after=snapshot()
  for(const table of ['products','supply_invoice_items','supplier_payments','cash_operations','inventory_movements']) expect(after[table]).toEqual(before[table])
})
it('supports replacing the product and reusing a line ID without changing stock at draft save',()=>{
  const before=snapshot()
  const result=supply.updateInvoice(invoice.id,{items:[{id:'old-a',product_id:'q',qty:98,purchase_price:100}]})
  expect(result.items).toHaveLength(1);expect(result.items[0]).toMatchObject({id:'old-a',product_id:'q',qty:98})
  expect(snapshot().products).toEqual(before.products)
})
it('posts multiple fractional rows once, keeping final purchase price and exact movements',()=>{
  const changed=supply.updateInvoice(invoice.id,{items:[{id:'fraction-a',product_id:'p',qty:0.1,purchase_price:100},{id:'fraction-b',product_id:'p',qty:0.2,purchase_price:200}]})
  const posted=supply.postInvoice(invoice.id,{expected_revision:changed.edit_revision,user_id:'owner'})
  expect(posted.total).toBe(50)
  expect(db.prepare('SELECT qty_on_hand,purchase_price FROM products WHERE id=?').get('p')).toEqual({qty_on_hand:3.3,purchase_price:200})
  expect(db.prepare('SELECT qty_delta,qty_after,unit_cost FROM inventory_movements ORDER BY rowid').all()).toEqual([
    {qty_delta:0.1,qty_after:3.1,unit_cost:100},{qty_delta:0.2,qty_after:3.3,unit_cost:200},
  ])
  db.close();db=new LocalDatabase(root);supply=new LocalSupplyRepository(db)
  const before=snapshot();expect(()=>supply.postInvoice(invoice.id)).toThrow();expect(snapshot()).toEqual(before)
})
it('rejects a stale edit or posting without affecting the newer draft',()=>{
  edit();const before=snapshot()
  expect(()=>supply.updateInvoice(invoice.id,{expected_revision:invoice.edit_revision,notes:'Stale'})).toThrow('DOCUMENT_CONFLICT')
  expect(()=>supply.postInvoice(invoice.id,{expected_revision:invoice.edit_revision})).toThrow('DOCUMENT_CONFLICT')
  expect(snapshot()).toEqual(before)
})
it.each(['foreign line','hidden line','wrong total','orphan movement'])('refuses damaged draft editing: %s',kind=>{
  if(kind==='foreign line') db.exec("UPDATE supply_invoice_items SET tenant_id='foreign' WHERE id='old-b'")
  if(kind==='hidden line') db.exec("UPDATE supply_invoice_items SET deleted_at='2026-10-08' WHERE id='old-b'")
  if(kind==='wrong total') db.exec('UPDATE supply_invoices SET total=1')
  if(kind==='orphan movement') db.prepare("INSERT INTO inventory_movements(id,tenant_id,product_id,source_type,source_id,qty_delta,qty_after,created_at,updated_at) VALUES('orphan',?,'p','supply_invoice','invoice',46,49,?,?)").run(tenant,at,at)
  const before=snapshot();expect(edit).toThrow();expect(snapshot()).toEqual(before)
})
it.each(['edit','post'])('preserves previous queue history during %s',kind=>{
  db.exec("CREATE TRIGGER old_queue AFTER INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice."+ (kind==='edit'?'updated':'posted')+"' BEGIN UPDATE sync_outbox SET payload_json='{}' WHERE operation_type='supplier_invoice.created'; END")
  const before=snapshot();expect(()=>kind==='edit'?edit():supply.postInvoice(invoice.id)).toThrow();expect(snapshot()).toEqual(before)
})
it('validates supplier change provenance when updating an existing history row',()=>{
  supply.updateInvoice(invoice.id,{supplier_id:'other'})
  db.exec("CREATE TRIGGER skip_provenance BEFORE UPDATE ON app_meta WHEN NEW.key LIKE 'invoice-supplier-changes:%' BEGIN SELECT RAISE(IGNORE); END")
  const before=snapshot();expect(()=>supply.updateInvoice(invoice.id,{supplier_id:'supplier'})).toThrow();expect(snapshot()).toEqual(before)
  db.exec('DROP TRIGGER skip_provenance');expect(supply.updateInvoice(invoice.id,{supplier_id:'supplier'}).supplier_id).toBe('supplier')
})
it.each(['header','line','product','movement','payment','cash','queue'])('rolls back complete receiving when final receipt changes %s',kind=>{
  const sql=kind==='header'?"UPDATE supply_invoices SET notes='Wrong' WHERE id='new-receiving'"
    :kind==='line'?"UPDATE supply_invoice_items SET qty=2,purchase_price=50 WHERE invoice_id='new-receiving'"
    :kind==='product'?"UPDATE products SET qty_on_hand=999 WHERE id='p'"
    :kind==='movement'?"DELETE FROM inventory_movements WHERE source_id='new-receiving'"
    :kind==='payment'?"UPDATE supplier_payments SET note='Wrong' WHERE invoice_id='new-receiving'"
    :kind==='cash'?'UPDATE cash_operations SET amount=76':"UPDATE sync_outbox SET payload_json='{}' WHERE aggregate_id='new-receiving'"
  db.exec("CREATE TRIGGER late_receiving AFTER INSERT ON app_meta WHEN NEW.key LIKE 'mutation:receiving:%' BEGIN "+sql+'; END')
  const input={operation_id:'receiving-once',invoice_id:'new-receiving',supplier_id:'supplier',user_id:'owner',
    items:[{client_key:'r1',product_id:'p',product_name:'Fixture p',sku:'p',qty:1,purchase_price:100,retail_price:0}],
    payments:[{amount:75,payment_method:'cash' as const,fund_source:'cashbox' as const,shift_id:'shift'}]}
  const before=snapshot();expect(()=>commitReceiving(db,input)).toThrow();expect(snapshot()).toEqual(before)
  db.exec('DROP TRIGGER late_receiving')
  expect(commitReceiving(db,input).status).toBe('posted')
  const after=snapshot();commitReceiving(db,input);expect(snapshot()).toEqual(after)
})

it.each(['header','delete one line','insert one line','queue'])('rolls back a skipped edit %s',kind=>{
  const trigger=kind==='header'?'BEFORE UPDATE ON supply_invoices':kind==='delete one line'?"BEFORE DELETE ON supply_invoice_items WHEN OLD.id='old-b'"
    :kind==='insert one line'?"BEFORE INSERT ON supply_invoice_items WHEN NEW.id='new-b'":"BEFORE INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice.updated'"
  db.exec('CREATE TRIGGER skip_edit '+trigger+' BEGIN SELECT RAISE(IGNORE); END')
  const before=snapshot();expect(edit).toThrow();expect(snapshot()).toEqual(before)
  db.exec('DROP TRIGGER skip_edit');expect(edit().items[0].qty).toBe(98)
})
it.each(['header','line','queue','late line','late stock','late payment','late cash'])('rejects wrong persisted edit %s',kind=>{
  supply.payInvoice(invoice.id,{amount:75,payment_method:'cash',fund_source:'cashbox',shift_id:'shift',user_id:'owner'})
  const trigger=kind==='header'?"AFTER UPDATE ON supply_invoices BEGIN UPDATE supply_invoices SET notes='Wrong' WHERE id=NEW.id; END"
    :kind==='line'?"AFTER INSERT ON supply_invoice_items WHEN NEW.id='new-a' BEGIN UPDATE supply_invoice_items SET qty=49,purchase_price=200 WHERE id=NEW.id; END"
    :kind==='queue'?"AFTER INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice.updated' BEGIN UPDATE sync_outbox SET payload_json='{}' WHERE operation_id=NEW.operation_id; END"
    :"AFTER INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice.updated' BEGIN "+(kind==='late line'?"UPDATE supply_invoice_items SET qty=49,purchase_price=200 WHERE id='new-a'"
      :kind==='late stock'?'UPDATE products SET qty_on_hand=99':kind==='late payment'?"UPDATE supplier_payments SET note='Wrong'":"UPDATE cash_operations SET amount=76")+'; END'
  db.exec('CREATE TRIGGER alter_edit '+trigger)
  const before=snapshot();expect(edit).toThrow();expect(snapshot()).toEqual(before)
})
it.each(['skip','alter','late'])('rolls back a supplier edit when its provenance is %s',kind=>{
  const trigger=kind==='skip'?"BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'invoice-supplier-changes:%' BEGIN SELECT RAISE(IGNORE); END"
    :kind==='alter'?"AFTER INSERT ON app_meta WHEN NEW.key LIKE 'invoice-supplier-changes:%' BEGIN UPDATE app_meta SET value_json='[]' WHERE key=NEW.key; END"
    :"AFTER INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice.updated' BEGIN UPDATE app_meta SET value_json='[]' WHERE key LIKE 'invoice-supplier-changes:%'; END"
  db.exec('CREATE TRIGGER supplier_edit '+trigger)
  const before=snapshot();expect(()=>supply.updateInvoice(invoice.id,{supplier_id:'other'})).toThrow();expect(snapshot()).toEqual(before)
})
it.each(['product','movement','header','queue'])('rolls back a skipped posting %s',kind=>{
  const trigger=kind==='product'?"BEFORE UPDATE ON products WHEN NEW.id='q'":kind==='movement'?"BEFORE INSERT ON inventory_movements WHEN NEW.product_id='q'"
    :kind==='header'?'BEFORE UPDATE ON supply_invoices':"BEFORE INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice.posted'"
  db.exec('CREATE TRIGGER skip_post '+trigger+' BEGIN SELECT RAISE(IGNORE); END')
  const before=snapshot();expect(()=>supply.postInvoice(invoice.id)).toThrow();expect(snapshot()).toEqual(before)
  db.exec('DROP TRIGGER skip_post');expect(supply.postInvoice(invoice.id).status).toBe('posted')
})
it.each(['stock','purchase','movement','header','queue','late line','late product','late movement','late cash'])('rejects wrong persisted posting %s',kind=>{
  supply.payInvoice(invoice.id,{amount:75,payment_method:'cash',fund_source:'cashbox',shift_id:'shift',user_id:'owner'})
  const trigger=kind==='stock'?"AFTER UPDATE ON products BEGIN UPDATE products SET qty_on_hand=qty_on_hand+1 WHERE id=NEW.id; END"
    :kind==='purchase'?"AFTER UPDATE ON products BEGIN UPDATE products SET purchase_price=999 WHERE id=NEW.id; END"
    :kind==='movement'?"AFTER INSERT ON inventory_movements BEGIN UPDATE inventory_movements SET qty_delta=qty_delta+1 WHERE id=NEW.id; END"
    :kind==='header'?"AFTER UPDATE ON supply_invoices BEGIN UPDATE supply_invoices SET posted_by='Wrong' WHERE id=NEW.id; END"
    :"AFTER INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice.posted' BEGIN "+(kind==='queue'?"UPDATE sync_outbox SET payload_json='{}' WHERE operation_id=NEW.operation_id"
      :kind==='late line'?"UPDATE supply_invoice_items SET qty=23,purchase_price=200 WHERE id='old-a'"
      :kind==='late product'?"UPDATE products SET name='Wrong' WHERE id='p'"
      :kind==='late movement'?"DELETE FROM inventory_movements WHERE source_id='invoice'"
      :'UPDATE cash_operations SET amount=76')+'; END'
  db.exec('CREATE TRIGGER alter_post '+trigger)
  const before=snapshot();expect(()=>supply.postInvoice(invoice.id)).toThrow();expect(snapshot()).toEqual(before)
})
it.each(['foreign line','hidden line','wrong header total','orphan movement'])('refuses a damaged draft before posting: %s',kind=>{
  if(kind==='foreign line') db.exec("UPDATE supply_invoice_items SET tenant_id='other' WHERE id='old-b'")
  if(kind==='hidden line') db.exec("UPDATE supply_invoice_items SET deleted_at='2026-10-08' WHERE id='old-b'")
  if(kind==='wrong header total') db.exec('UPDATE supply_invoices SET total=1')
  if(kind==='orphan movement') db.prepare("INSERT INTO inventory_movements(id,tenant_id,product_id,source_type,source_id,qty_delta,qty_after,created_at,updated_at) VALUES('orphan',?,'p','supply_invoice','invoice',46,49,?,?)").run(tenant,at,at)
  const before=snapshot();expect(()=>supply.postInvoice(invoice.id)).toThrow();expect(snapshot()).toEqual(before)
})
