// Compiled Electron runtime, isolated synthetic data only. Never opens a shop DB.
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { LocalDatabase } = require('../dist/db/localDatabase')
const { LocalSupplyRepository } = require('../dist/repositories/supplyRepository')
const { DEFAULT_TENANT_ID: tenant } = require('../dist/db/localTypes')
const root = mkdtempSync(path.join(tmpdir(), 'forsage-merge-write-smoke-'))
let db, supply, checks = 0
const equal = (a,b,message) => { assert.deepEqual(a,b,message); checks++ }
const snapshot = () => JSON.stringify(['suppliers','supply_invoices','supply_invoice_items','supplier_payments','cash_operations','products','sync_outbox','app_meta']
  .map(table => db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()))
try {
  db = new LocalDatabase(root); supply = new LocalSupplyRepository(db)
  const at='2026-10-07T06:00:00Z'
  db.prepare('INSERT INTO products(id,tenant_id,sku,name,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('p',tenant,'TEST','Fixture',at,at)
  db.prepare('INSERT INTO shifts(id,tenant_id,cashier_id,opening_cash,opened_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('shift',tenant,'owner',100000,at,at,at)
  let last
  for (const kind of ['supply_invoices','supplier_payments','cash_operations','suppliers','sync_outbox','app_meta','empty suppliers','empty sync_outbox','empty app_meta']) {
    const table=kind.replace('empty ','')
    const source=supply.saveSupplier({name:'Fixture source '+kind}).id
    const target=supply.saveSupplier({name:'Fixture target '+kind}).id
    if(!kind.startsWith('empty ')) {
      const a=supply.createInvoice({supplier_id:source,paid_amount:25,payment_method:'cash',fund_source:'cashbox',shift_id:'shift',user_id:'owner',items:[{product_id:'p',qty:2,purchase_price:100}]})
      supply.postInvoice(a.id)
      supply.payInvoice(a.id,{amount:50,payment_method:'cash',fund_source:'cashbox',shift_id:'shift',user_id:'owner'})
    }
    const insert=table==='sync_outbox'||table==='app_meta'
    const when=table==='sync_outbox'?" WHEN NEW.operation_type='supplier.merged'":table==='app_meta'?" WHEN NEW.key LIKE 'supplier-merge:%'":''
    db.exec('CREATE TRIGGER skip_merge BEFORE '+(insert?'INSERT':'UPDATE')+' ON '+table+when+' BEGIN SELECT RAISE(IGNORE); END')
    const before=snapshot()
    assert.throws(()=>supply.mergeSuppliers(target,source));checks++
    equal(snapshot(),before,'Partial write escaped rollback: '+kind)
    db.exec('DROP TRIGGER skip_merge')
    const stock=JSON.stringify(db.prepare('SELECT * FROM products ORDER BY id').all())
    supply.mergeSuppliers(target,source)
    equal(JSON.stringify(db.prepare('SELECT * FROM products ORDER BY id').all()),stock)
    const after=snapshot();supply.mergeSuppliers(target,source);equal(snapshot(),after)
    equal(db.prepare("SELECT count(*) n FROM sync_outbox WHERE aggregate_id=? AND operation_type='supplier.merged'").get(target).n,1)
    last={target,source}
  }
  db.exec('DELETE FROM sync_outbox');db.close();db=new LocalDatabase(root);supply=new LocalSupplyRepository(db)
  const before=snapshot();supply.mergeSuppliers(last.target,last.source);equal(snapshot(),before,'Restart duplicated a merge')
  console.log(JSON.stringify({ok:true,checks,packagedExe:false,shopDatabaseOpened:false,networkRequests:false,printerJobs:false}))
} finally {
  db?.close()
  if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-merge-write-smoke-'))rmSync(root,{recursive:true,force:true})
}
