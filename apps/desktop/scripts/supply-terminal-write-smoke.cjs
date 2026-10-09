// Isolated synthetic fixtures only. No shop database, network, UI or print jobs.
const { mkdtempSync, rmSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { LocalDatabase } = require('../dist/db/localDatabase')
const { LocalSupplyRepository } = require('../dist/repositories/supplyRepository')
const { DEFAULT_TENANT_ID: tenant } = require('../dist/db/localTypes')
const root=mkdtempSync(path.join(tmpdir(),'forsage-terminal-write-smoke-'))
let db,supply,checks=0
const equal=(a,b)=>{assert.deepEqual(a,b);checks++}
const rejects=work=>{assert.throws(work);checks++}
const snapshot=()=>JSON.stringify(['products','supply_invoices','supply_invoice_items','supplier_payments','cash_operations','inventory_movements','sync_outbox','app_meta']
  .map(table=>db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()))
const create=()=>supply.createInvoice({id:randomUUID(),items:[{product_id:'p',qty:2,purchase_price:100},{product_id:'q',qty:1,purchase_price:50}]})
try {
  db=new LocalDatabase(root);supply=new LocalSupplyRepository(db)
  const at='2026-10-08T12:00:00.000Z'
  for(const id of ['p','q']) db.prepare('INSERT INTO products(id,tenant_id,sku,name,qty_on_hand,purchase_price,created_at,updated_at) VALUES(?,?,?,?,3,20,?,?)').run(id,tenant,id,'Fixture '+id,at,at)
  for(const action of ['cancel','delete']) {
    for(const kind of action==='cancel'?['product','movement','header','queue','receipt']:['line','header','queue','receipt']) {
      const draft=create(), invoice=action==='cancel'?supply.postInvoice(draft.id):draft
      const target=kind==='product'?"BEFORE UPDATE ON products WHEN NEW.id='q'"
        :kind==='movement'?"BEFORE INSERT ON inventory_movements WHEN NEW.source_type='supply_invoice_cancel' AND NEW.product_id='q'"
        :kind==='line'?"BEFORE DELETE ON supply_invoice_items WHEN OLD.product_id='q'"
        :kind==='header'?(action==='cancel'?'BEFORE UPDATE ON supply_invoices':'BEFORE DELETE ON supply_invoices')
        :kind==='queue'?"BEFORE INSERT ON sync_outbox WHEN NEW.operation_type='supplier_invoice."+(action==='cancel'?'cancelled':'deleted')+"'"
        :"BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'supply-terminal:%'"
      const finish=()=>action==='cancel'?supply.cancelInvoice(invoice.id,tenant,invoice.edit_revision):supply.deleteInvoice(invoice.id,tenant,invoice.edit_revision)
      db.exec('CREATE TRIGGER skip_terminal '+target+' BEGIN SELECT RAISE(IGNORE); END')
      const before=snapshot();rejects(finish);equal(snapshot(),before)
      db.exec('DROP TRIGGER skip_terminal');finish()
      equal(db.prepare("SELECT qty_on_hand FROM products WHERE id='p'").get().qty_on_hand,3)
      const after=snapshot();finish();equal(snapshot(),after)
    }
  }
  for(const kind of ['stock','movement','header','queue','receipt']) {
    const invoice=create();supply.postInvoice(invoice.id)
    const sql=kind==='stock'?"UPDATE products SET qty_on_hand=99 WHERE id='p'"
      :kind==='movement'?"UPDATE inventory_movements SET qty_delta=-99 WHERE source_id='"+invoice.id+"' AND source_type='supply_invoice_cancel'"
      :kind==='header'?"UPDATE supply_invoices SET notes='Wrong' WHERE id='"+invoice.id+"'"
      :kind==='queue'?"UPDATE sync_outbox SET payload_json='{}' WHERE aggregate_id='"+invoice.id+"'"
      :"UPDATE app_meta SET value_json='{}' WHERE key=NEW.key"
    db.exec("CREATE TRIGGER late_terminal AFTER INSERT ON app_meta WHEN NEW.key LIKE 'supply-terminal:%' BEGIN "+sql+'; END')
    const before=snapshot();rejects(()=>supply.cancelInvoice(invoice.id));equal(snapshot(),before)
    db.exec('DROP TRIGGER late_terminal');supply.cancelInvoice(invoice.id)
  }
  const fractional=create()
  supply.updateInvoice(fractional.id,{items:[{product_id:'p',qty:0.1,purchase_price:100},{product_id:'p',qty:0.2,purchase_price:200}]})
  const posted=supply.postInvoice(fractional.id)
  supply.cancelInvoice(fractional.id,tenant,posted.edit_revision)
  equal({...db.prepare("SELECT qty_on_hand,purchase_price FROM products WHERE id='p'").get()},{qty_on_hand:3,purchase_price:200})
  equal(db.prepare("SELECT qty_delta,qty_after FROM inventory_movements WHERE source_id=? AND source_type='supply_invoice_cancel' ORDER BY rowid").all(fractional.id).map(row=>({...row})),
    [{qty_delta:-0.1,qty_after:3.2},{qty_delta:-0.2,qty_after:3}])
  db.exec("UPDATE products SET qty_on_hand=777 WHERE id='p'; UPDATE inventory_movements SET dirty_at=NULL,remote_updated_at='2026-10-09',updated_at='2026-10-09'; DELETE FROM sync_outbox")
  db.close();db=new LocalDatabase(root);supply=new LocalSupplyRepository(db)
  const restarted=snapshot();supply.cancelInvoice(fractional.id,tenant,posted.edit_revision);equal(snapshot(),restarted)
  db.prepare("UPDATE inventory_movements SET qty_after=99 WHERE source_id=? AND source_type='supply_invoice_cancel'").run(fractional.id)
  const damaged=snapshot();rejects(()=>supply.cancelInvoice(fractional.id));equal(snapshot(),damaged)
  equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok')
  console.log(JSON.stringify({ok:true,checks,packagedExe:false,shopDatabaseOpened:false,networkRequests:false,printerJobs:false}))
} finally {
  db?.close()
  if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-terminal-write-smoke-'))rmSync(root,{recursive:true,force:true})
}
