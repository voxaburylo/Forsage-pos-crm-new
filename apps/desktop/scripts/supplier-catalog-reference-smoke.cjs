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
  console.log(JSON.stringify({ok:true,staged:process.argv.includes('--staged'),checks:5,shopDatabaseOpened:false}))
} finally {
  db?.close()
  if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-price-supplier-smoke-'))rmSync(root,{recursive:true,force:true})
}
