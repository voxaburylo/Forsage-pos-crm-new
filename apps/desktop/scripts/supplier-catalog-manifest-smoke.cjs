// Isolated synthetic SQLite only; no network, printers or shop database.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict')
const {performance}=require('node:perf_hooks')
const {LocalDatabase}=require('../dist/db/localDatabase')
const {LocalSyncRepository}=require('../dist/repositories/syncRepository')
const {LocalBootstrapRepository}=require('../dist/repositories/bootstrapRepository')
const {createSupplierCatalogManifest}=require('../dist/lib/supplierCatalogManifest')
const tenant='00000000-0000-0000-0000-000000000001',at='2026-10-09T10:00:00.123456+00:00'
let checks=0
function copy(n=26) {
  const items=Array.from({length:n},(_,i)=>({id:'item-'+i,tenant_id:tenant,sku:'SKU-'+i,name:'Filter '+i,
    qty:'0.125',price_kopecks:100,created_at:at,updated_at:at,deleted_at:null}))
  const imports=[{id:'history',tenant_id:tenant,filename:'fixture.csv',mode:'replace',warehouse_name:null,
    total_rows:n,processed_rows:n,status:'completed',errors_log:[],created_at:at,updated_at:at}]
  return {tenant_id:tenant,cursor:at,exported_at:at,supplier_price_items:items,supplier_price_imports:imports,
    supplier_catalog_copy:createSupplierCatalogManifest(tenant,at,items,imports)}
}
async function run() {
  let elapsedMs=0
  for(const route of ['sync','chunked','bootstrap','bootstrap-chunked']) {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'forsage-catalog-manifest-native-'))
    let db
    try {
      db=new LocalDatabase(root)
      const sync=new LocalSyncRepository(db)
      const apply=input=>Promise.resolve().then(()=>route==='sync'?sync.applyPullChanges(input)
        :route==='chunked'?sync.applyPullChangesChunked(input)
        :route==='bootstrap-chunked'?sync.importSnapshotChunked(input)
        :new LocalBootstrapRepository(db).importSnapshot(input))
      const snap=()=>JSON.stringify(['supplier_price_items','supplier_price_imports','products','sync_state','app_meta','sync_outbox']
        .map(table=>db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()))
      for(const fault of ['item','history','price','cursor']) {
        const input=copy()
        if(fault==='item')input.supplier_price_items.pop()
        if(fault==='history')input.supplier_price_imports=[]
        if(fault==='price')input.supplier_price_items[0].price_kopecks=999
        if(fault==='cursor')input.supplier_catalog_copy.cursor='2026-10-10T10:00:00Z'
        const before=snap()
        await assert.rejects(()=>apply(input));checks++
        assert.equal(snap(),before);checks++
      }
      const input=JSON.parse(JSON.stringify(copy(route==='chunked'?15000:26)))
      const start=performance.now()
      await apply(input)
      if(route==='chunked')elapsedMs=Math.round(performance.now()-start)
      assert.equal(db.prepare('SELECT count(*) n FROM supplier_price_items').get().n,input.supplier_price_items.length);checks++
      assert.equal(db.prepare('SELECT count(*) n FROM supplier_price_imports').get().n,1);checks++
      assert.equal(db.prepare('SELECT qty FROM supplier_price_items LIMIT 1').get().qty,0.125);checks++
      assert.equal(db.prepare('SELECT count(*) n FROM sync_outbox').get().n,0);checks++
      assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0],'ok');checks++
      const saved=snap()
      db.close();db=new LocalDatabase(root)
      assert.equal(snap(),saved);checks++
    } finally {
      db?.close()
      if(path.dirname(path.resolve(root))===path.resolve(os.tmpdir())&&path.basename(root).startsWith('forsage-catalog-manifest-native-'))
        fs.rmSync(root,{recursive:true,force:true})
    }
  }
  console.log(JSON.stringify({ok:true,checks,manifestRows:15000,elapsedMs,shopDatabaseOpened:false}))
}
run().catch(error=>{console.error(error);process.exitCode=1})
