// Compiled Electron runtime, isolated synthetic data only. Never opens a shop DB.
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const stagedModules = process.argv.includes('--staged')
const dist = path.resolve(__dirname, stagedModules ? '../release/staged/win-unpacked/resources/app.asar/dist' : '../dist')
const { LocalDatabase } = require(path.join(dist, 'db/localDatabase'))
const { LocalSupplyRepository } = require(path.join(dist, 'repositories/supplyRepository'))
const { DEFAULT_TENANT_ID: tenant } = require(path.join(dist, 'db/localTypes'))
const root = mkdtempSync(path.join(tmpdir(), 'forsage-merge-write-smoke-'))
let db, supply, checks = 0
const equal = (a,b,message) => { assert.deepEqual(a,b,message); checks++ }
const snapshot = () => JSON.stringify(['suppliers','supply_invoices','supply_invoice_items','supplier_payments','cash_operations','products','sync_outbox','app_meta','supplier_price_items','supplier_price_imports']
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

  const { LocalSupplierCatalogRepository } = require(path.join(dist, 'repositories/supplierCatalogRepository'))
  let catalog=new LocalSupplierCatalogRepository(db)
  const priceSource=supply.saveSupplier({name:'Catalog source'}).id
  const priceTarget=supply.saveSupplier({name:'Catalog target'}).id
  const third=supply.saveSupplier({name:'Catalog third'}).id
  const fourth=supply.saveSupplier({name:'Catalog fourth'}).id
  const item=catalog.create({supplier_id:priceSource,sku:'NATIVE-ITEM',name:'Native price',qty:'1.125',price_kopecks:1200})
  const importRows=[{source_row:1,sku:'NATIVE-IMPORT',name:'Native imported price',qty:'0.25',price_kopecks:777}]
  const importOptions={supplier_id:priceSource,mode:'add',operation_id:'native-attempt',user_id:'owner'}
  const imported=catalog.importRows('native.csv',importRows,importOptions)
  const products=JSON.stringify(db.prepare('SELECT * FROM products ORDER BY id').all())
  for(const kind of ['item','import','receipt','late stock']) {
    const trigger=kind==='item'?'BEFORE UPDATE ON supplier_price_items BEGIN SELECT RAISE(IGNORE); END'
      :kind==='import'?'BEFORE UPDATE ON supplier_price_imports BEGIN SELECT RAISE(IGNORE); END'
      :kind==='receipt'?"BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'supplier-merge:%' BEGIN SELECT RAISE(IGNORE); END"
      :"AFTER INSERT ON app_meta WHEN NEW.key LIKE 'supplier-merge:%' BEGIN UPDATE products SET qty_on_hand=qty_on_hand+1; END"
    db.exec('CREATE TRIGGER catalog_merge_fault '+trigger)
    const before=snapshot();assert.throws(()=>supply.mergeSuppliers(priceTarget,priceSource));checks++
    equal(snapshot(),before,'Catalog transaction partially committed: '+kind)
    db.exec('DROP TRIGGER catalog_merge_fault')
  }
  supply.mergeSuppliers(priceTarget,priceSource)
  equal(catalog.list({supplier_id:priceTarget}).data.length,2)
  equal(db.prepare('SELECT supplier_id FROM supplier_price_imports WHERE id=?').get(imported.importId).supplier_id,priceTarget)
  equal(JSON.stringify(db.prepare('SELECT * FROM products ORDER BY id').all()),products)
  catalog.update(item.id,{supplier_id:third});supply.mergeSuppliers(fourth,third)
  db.exec('DELETE FROM sync_outbox');db.close();db=new LocalDatabase(root);supply=new LocalSupplyRepository(db);catalog=new LocalSupplierCatalogRepository(db)
  const after=snapshot();supply.mergeSuppliers(priceTarget,priceSource);supply.mergeSuppliers(fourth,third)
  equal(catalog.importRows('native.csv',importRows,importOptions),imported)
  equal(snapshot(),after,'Restart/import retry rewrote the moved catalog')
  equal(catalog.list({supplier_id:fourth}).data[0].id,item.id)

  console.log(JSON.stringify({ok:true,checks,stagedModules,packagedExe:path.basename(process.execPath).toLowerCase()==='forsage.exe',shopDatabaseOpened:false,networkRequests:false,printerJobs:false}))
} finally {
  db?.close()
  if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-merge-write-smoke-'))rmSync(root,{recursive:true,force:true})
}
