// Isolated synthetic database only: no shop data, UI, network or print jobs.
const { mkdtempSync, rmSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { LocalDatabase } = require('../dist/db/localDatabase')
const { LocalSupplyRepository } = require('../dist/repositories/supplyRepository')
const { commitReceiving } = require('../dist/repositories/receivingCommit')
const { DEFAULT_TENANT_ID: tenant } = require('../dist/db/localTypes')
const root = mkdtempSync(path.join(tmpdir(), 'forsage-supply-write-smoke-'))
let db, supply, checks = 0
const equal = (a,b) => { assert.deepEqual(a,b); checks++ }
const rejects = work => { assert.throws(work); checks++ }
const snapshot = () => JSON.stringify(['products','supply_invoices','supply_invoice_items','supplier_payments',
  'cash_operations','inventory_movements','sync_outbox','app_meta'].map(table=>db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()))
const create = () => supply.createInvoice({id:randomUUID(),supplier_id:'supplier',
  items:[{product_id:'p',qty:46,purchase_price:100},{product_id:'q',qty:1,purchase_price:50}]})
try {
  db = new LocalDatabase(root); supply = new LocalSupplyRepository(db)
  const at='2026-10-08T12:00:00.000Z'
  for(const id of ['p','q']) db.prepare('INSERT INTO products(id,tenant_id,sku,name,qty_on_hand,purchase_price,created_at,updated_at) VALUES(?,?,?,?,3,20,?,?)').run(id,tenant,id,'Fixture '+id,at,at)
  for(const id of ['supplier','other']) db.prepare('INSERT INTO suppliers(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,tenant,id,at,at)
  db.prepare('INSERT INTO shifts(id,tenant_id,cashier_id,opening_cash,opened_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('shift',tenant,'owner',100000,at,at,at)

  for(const action of ['edit','post']) for(const part of ['header','line','stock or removal','queue']) {
    const invoice=create(), event=action==='edit'?'updated':'posted'
    const target=part==='header'?'BEFORE UPDATE ON supply_invoices'
      :part==='line'?(action==='edit'?"BEFORE INSERT ON supply_invoice_items WHEN NEW.product_id='q'":"BEFORE INSERT ON inventory_movements WHEN NEW.product_id='q'")
      :part==='stock or removal'?(action==='edit'?"BEFORE DELETE ON supply_invoice_items WHEN OLD.product_id='q'":"BEFORE UPDATE ON products WHEN NEW.id='q'")
      :"BEFORE INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice."+event+"'"
    const work=()=>action==='edit'?supply.updateInvoice(invoice.id,{items:[{product_id:'p',qty:98,purchase_price:100},{product_id:'q',qty:2,purchase_price:50}]}):supply.postInvoice(invoice.id)
    db.exec('CREATE TRIGGER skip_write '+target+' BEGIN SELECT RAISE(IGNORE); END')
    const before=snapshot();rejects(work);equal(snapshot(),before)
    db.exec('DROP TRIGGER skip_write')
    equal(work().status,action==='edit'?'draft':'posted')
  }
  for(const action of ['edit','post']) for(const part of ['line','stock','cash']) {
    const invoice=create(), event=action==='edit'?'updated':'posted'
    supply.payInvoice(invoice.id,{amount:75,payment_method:'cash',fund_source:'cashbox',shift_id:'shift',user_id:'owner'})
    const sql=part==='line'?"UPDATE supply_invoice_items SET qty=23,purchase_price=200 WHERE invoice_id='"+invoice.id+"' AND product_id='p'"
      :part==='stock'?"UPDATE products SET qty_on_hand=999 WHERE id='p'":'UPDATE cash_operations SET amount=76'
    db.exec("CREATE TRIGGER alter_write AFTER INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice."+event+"' BEGIN "+sql+'; END')
    const before=snapshot();rejects(()=>action==='edit'?supply.updateInvoice(invoice.id,{notes:'Edited'}):supply.postInvoice(invoice.id));equal(snapshot(),before)
    db.exec('DROP TRIGGER alter_write')
  }
  const supplierInvoice=create()
  db.exec("CREATE TRIGGER skip_provenance BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'invoice-supplier-changes:%' BEGIN SELECT RAISE(IGNORE); END")
  const beforeSupplier=snapshot();rejects(()=>supply.updateInvoice(supplierInvoice.id,{supplier_id:'other'}));equal(snapshot(),beforeSupplier)
  db.exec('DROP TRIGGER skip_provenance')
  equal(supply.updateInvoice(supplierInvoice.id,{supplier_id:'other'}).supplier_id,'other')

  for(const part of ['header','movement','cash','queue']) {
    const input={operation_id:randomUUID(),invoice_id:randomUUID(),supplier_id:'supplier',user_id:'owner',
      items:[{client_key:'row',product_id:'p',product_name:'Fixture p',sku:'p',qty:98,purchase_price:100,retail_price:0}],
      payments:[{amount:75,payment_method:'cash',fund_source:'cashbox',shift_id:'shift'}]}
    const sql=part==='header'?"UPDATE supply_invoices SET notes='Wrong' WHERE id='"+input.invoice_id+"'"
      :part==='movement'?"DELETE FROM inventory_movements WHERE source_id='"+input.invoice_id+"'"
      :part==='cash'?'UPDATE cash_operations SET amount=76':"UPDATE sync_outbox SET payload_json='{}' WHERE aggregate_id='"+input.invoice_id+"'"
    db.exec("CREATE TRIGGER late_receiving AFTER INSERT ON app_meta WHEN NEW.key LIKE 'mutation:receiving:%' BEGIN "+sql+'; END')
    const before=snapshot();rejects(()=>commitReceiving(db,input));equal(snapshot(),before)
    db.exec('DROP TRIGGER late_receiving')
    equal(commitReceiving(db,input).status,'posted')
    const after=snapshot();commitReceiving(db,input);equal(snapshot(),after)
  }

  const fractional=create(), oldStock=db.prepare("SELECT qty_on_hand FROM products WHERE id='p'").get().qty_on_hand
  supply.updateInvoice(fractional.id,{items:[{product_id:'p',qty:0.1,purchase_price:100},{product_id:'p',qty:0.2,purchase_price:200}]})
  equal(db.prepare("SELECT qty_on_hand FROM products WHERE id='p'").get().qty_on_hand,oldStock)
  equal(supply.postInvoice(fractional.id).total,50)
  equal({...db.prepare("SELECT qty_on_hand,purchase_price FROM products WHERE id='p'").get()},{qty_on_hand:oldStock+0.3,purchase_price:200})
  equal(db.prepare('SELECT qty_delta,qty_after FROM inventory_movements WHERE source_id=? ORDER BY rowid').all(fractional.id).map(row=>({...row})),
    [{qty_delta:0.1,qty_after:oldStock+0.1},{qty_delta:0.2,qty_after:oldStock+0.3}])
  db.close();db=new LocalDatabase(root);supply=new LocalSupplyRepository(db)
  const restarted=snapshot();rejects(()=>supply.postInvoice(fractional.id));equal(snapshot(),restarted)
  equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok')
  console.log(JSON.stringify({ok:true,checks,packagedExe:false,shopDatabaseOpened:false,networkRequests:false,printerJobs:false}))
} finally {
  db?.close()
  if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-supply-write-smoke-'))rmSync(root,{recursive:true,force:true})
}
