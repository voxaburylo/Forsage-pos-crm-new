// Synthetic fixture only. No shop database, server requests or printer jobs.
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const dist = path.resolve(__dirname, process.argv.includes('--staged') ? '../release/staged/win-unpacked/resources/app.asar/dist' : '../dist')
const { LocalDatabase } = require(path.join(dist,'db/localDatabase'))
const { LocalSupplyRepository } = require(path.join(dist,'repositories/supplyRepository'))
const { LocalSupplierCatalogRepository } = require(path.join(dist,'repositories/supplierCatalogRepository'))
const root = mkdtempSync(path.join(tmpdir(),'forsage-price-supplier-smoke-'))
let db
try {
  db = new LocalDatabase(root)
  const supply = new LocalSupplyRepository(db), catalog = new LocalSupplierCatalogRepository(db)
  const source = supply.saveSupplier({name:'Fixture duplicate'}).id
  const target = supply.saveSupplier({name:'Fixture primary'}).id
  const item = {name:'Fixture price item',sku:'FIXTURE',price_kopecks:100,qty:'2'}
  catalog.create({...item,supplier_id:null})
  supply.mergeSuppliers(target,source)
  const snapshot = () => JSON.stringify(['suppliers','supplier_price_items','supplier_price_imports','sync_outbox','products']
    .map(table => db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()))
  const before = snapshot()
  assert.throws(()=>catalog.importRows('fixture.csv',[{...item,source_row:1}],{supplier_id:source,mode:'replace'}),/Постачальник/)
  assert.equal(snapshot(),before,'Rejected import changed the fixture')
  catalog.importRows('fixture.csv',[{...item,source_row:1}],{supplier_id:target,mode:'replace'})
  assert.equal(db.prepare('SELECT count(*) n FROM supplier_price_items WHERE supplier_id IS NULL AND deleted_at IS NULL').get().n,1)
  assert.equal(db.prepare('SELECT count(*) n FROM supplier_price_items WHERE supplier_id=? AND deleted_at IS NULL').get(target).n,1)
  assert.equal(db.prepare('SELECT count(*) n FROM products').get().n,0)
  supply.deleteSupplier(target)
  catalog.upsertRemoteImport({id:'historical-import',supplier_id:target,filename:'old.csv'},'00000000-0000-0000-0000-000000000001','2026-10-07T06:00:00Z')
  assert.equal(db.prepare('SELECT supplier_id FROM supplier_price_imports WHERE id=?').get('historical-import').supplier_id,target)
  assert.throws(()=>catalog.create({...item,supplier_id:target}),/Постачальник/)
  const tenant = '00000000-0000-0000-0000-000000000001'
  const at = '2026-10-07T06:00:00Z'
  for (const kind of ['item','import']) {
    const record = {...item,id:'foreign-'+kind,supplier_id:null,filename:'fixture.csv'}
    const apply = value => kind==='item' ? catalog.upsertRemoteItem(value,tenant,at) : catalog.upsertRemoteImport(value,tenant,at)
    assert.equal(apply(record),true)
    const table = kind==='item' ? 'supplier_price_items' : 'supplier_price_imports'
    db.prepare('UPDATE '+table+' SET tenant_id=? WHERE id=?').run('another-tenant',record.id)
    const original = snapshot()
    assert.throws(()=>apply({...record,name:'Must not replace',filename:'replacement.csv'}),/організації/)
    assert.equal(snapshot(),original,'Foreign catalog record changed')
  }
  const imported = catalog.importRows('repeated.csv',[1,2,3].map(source_row=>({...item,sku:'REPEAT',name:'Repeated fixture',qty:'2',source_row})),{mode:'replace',warehouse_name:'Fixture'})
  const payload = JSON.parse(db.prepare('SELECT payload_json FROM sync_outbox WHERE aggregate_id=?').get(imported.importId).payload_json)
  assert.equal(payload.items.length,1)
  assert.equal(payload.items[0].qty,'6')
  assert.equal(payload.import.processed_rows,3)
  catalog.upsertRemoteImport({id:'scope-fixture',mode:'replace',warehouse_name:'Fixture'},tenant,at)
  assert.deepEqual({...db.prepare('SELECT mode,warehouse_name,scope_known FROM supplier_price_imports WHERE id=?').get('scope-fixture')},{mode:'replace',warehouse_name:'Fixture',scope_known:1})
  assert.equal(db.prepare('SELECT scope_known FROM supplier_price_imports WHERE id=?').get('historical-import').scope_known,0)
  console.log(JSON.stringify({ok:true,staged:process.argv.includes('--staged'),checks:18,shopDatabaseOpened:false}))
} finally {
  db?.close()
  if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-price-supplier-smoke-'))rmSync(root,{recursive:true,force:true})
}
