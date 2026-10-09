// Isolated synthetic fixtures only; this script never opens the shop database.
const { mkdtempSync, rmSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { LocalDatabase } = require('../dist/db/localDatabase')
const { LocalSupplyRepository } = require('../dist/repositories/supplyRepository')
const { DEFAULT_TENANT_ID: tenant } = require('../dist/db/localTypes')
const root = mkdtempSync(path.join(tmpdir(), 'forsage-supply-create-smoke-'))
let db, supply, checks = 0
const equal = (a,b) => { assert.deepEqual(a,b); checks++ }
const rejects = work => { assert.throws(work); checks++ }
const snapshot = () => JSON.stringify(['products','product_barcodes','categories','brands','suppliers','supply_invoices','supply_invoice_items','supplier_payments','cash_operations','inventory_movements','sync_outbox','app_meta']
  .map(table => db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()))
const input = () => ({
  id:randomUUID(),operation_id:randomUUID(),supplier_id:'supplier',invoice_number:'Fixture',notes:'Original',
  paid_amount:100,payment_method:'cash',fund_source:'cashbox',shift_id:'shift',user_id:'owner',
  items:[{id:randomUUID(),product_id:'p',qty:2,purchase_price:100},{id:randomUUID(),product_id:'p',qty:1,purchase_price:200}],
})
try {
  db = new LocalDatabase(root); supply = new LocalSupplyRepository(db)
  const at='2026-10-08T09:00:00.000Z'
  db.prepare('INSERT INTO products(id,tenant_id,sku,name,qty_on_hand,created_at,updated_at) VALUES(?,?,?,?,7,?,?)').run('p',tenant,'TEST','Fixture',at,at)
  db.prepare('INSERT INTO suppliers(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('supplier',tenant,'Fixture',at,at)
  db.prepare('INSERT INTO shifts(id,tenant_id,cashier_id,opening_cash,opened_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('shift',tenant,'owner',100000,at,at,at)
  let last
  for (const table of ['supply_invoices','supply_invoice_items','sync_outbox','app_meta']) {
    const body = input()
    db.exec('CREATE TRIGGER skip_create BEFORE INSERT ON '+table+' BEGIN SELECT RAISE(IGNORE); END')
    const before=snapshot();rejects(()=>supply.createInvoice(body));equal(snapshot(),before)
    db.exec('DROP TRIGGER skip_create')
    equal(supply.createInvoice(body).items.length,2)
    const after=snapshot();supply.createInvoice(body);equal(snapshot(),after)
    last=body
  }
  for (const kind of ['line','queue','receipt','late document','late cash','late stock']) {
    const body=input()
    const trigger=kind==='line'?"AFTER INSERT ON supply_invoice_items WHEN NEW.id='"+body.items[0].id+"' BEGIN UPDATE supply_invoice_items SET qty=1,purchase_price=200 WHERE id=NEW.id; END"
      :kind==='queue'?"AFTER INSERT ON sync_outbox BEGIN UPDATE sync_outbox SET payload_json='{}' WHERE operation_id=NEW.operation_id; END"
      :kind==='receipt'?"AFTER INSERT ON app_meta WHEN NEW.key LIKE 'mutation:supply-create:%' BEGIN UPDATE app_meta SET value_json='{}' WHERE key=NEW.key; END"
      :kind==='late document'?"AFTER INSERT ON app_meta WHEN NEW.key LIKE 'mutation:supply-create:%' BEGIN UPDATE supply_invoices SET notes='Wrong'; END"
      :kind==='late cash'?"AFTER INSERT ON app_meta WHEN NEW.key LIKE 'mutation:supply-create:%' BEGIN UPDATE cash_operations SET amount=amount+1; END"
      :"AFTER INSERT ON app_meta WHEN NEW.key LIKE 'mutation:supply-create:%' BEGIN UPDATE products SET qty_on_hand=99; END"
    db.exec('CREATE TRIGGER alter_create '+trigger)
    const before=snapshot();rejects(()=>supply.createInvoice(body));equal(snapshot(),before)
    db.exec('DROP TRIGGER alter_create')
  }
  for (const kind of ['queue','receipt']) {
    const table=kind==='queue'?'sync_outbox':'app_meta'
    const when=kind==='queue'?"NEW.operation_type='supplier_invoice.created'":"NEW.key LIKE 'mutation:ai-invoice:%'"
    db.exec('CREATE TRIGGER skip_ai BEFORE INSERT ON '+table+' WHEN '+when+' BEGIN SELECT RAISE(IGNORE); END')
    const before=snapshot()
    rejects(()=>supply.createInvoiceFromAiRows({operation_id:randomUUID(),supplier_name:'AI fixture',rows:[{
      name:'Ключ новий TEST 18',sku:'NEW-18',brand:'TestBrand',category:'Ключі',qty:2,purchase_price_uah:100,
    }]}))
    equal(snapshot(),before);db.exec('DROP TRIGGER skip_ai')
  }
  equal(db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get('p').qty_on_hand,7)
  db.exec('DELETE FROM sync_outbox');db.close();db=new LocalDatabase(root);supply=new LocalSupplyRepository(db)
  const before=snapshot();supply.createInvoice(last);equal(snapshot(),before)
  supply.updateInvoice(last.id,{items:[{product_id:'p',qty:98,purchase_price:100}]})
  const edited=snapshot();supply.createInvoice(last);equal(snapshot(),edited)
  equal(supply.getInvoice(last.id).items[0].qty,98)
  console.log(JSON.stringify({ok:true,checks,packagedExe:false,shopDatabaseOpened:false,networkRequests:false,printerJobs:false}))
} finally {
  db?.close()
  if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-supply-create-smoke-'))rmSync(root,{recursive:true,force:true})
}
