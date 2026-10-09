import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach,afterEach,expect,it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalSyncRepository } from '../src/repositories/syncRepository'
import { LocalBootstrapRepository } from '../src/repositories/bootstrapRepository'
import { createSupplierCatalogManifest,validateSupplierCatalogManifest } from '../src/lib/supplierCatalogManifest'
const at='2026-10-09T10:00:00.000Z'
let db:LocalDatabase,root:string,sync:LocalSyncRepository
const copy=():any=>{
  const items=Array.from({length:26},(_,i)=>({id:'price-'+i,tenant_id:tenant,sku:'SKU-'+i,name:'Filter '+i,qty:'0.125',price_kopecks:100,updated_at:at}))
  const imports=[{id:'history',tenant_id:tenant,filename:'price.csv',total_rows:26,processed_rows:26,updated_at:at}]
  return {tenant_id:tenant,cursor:at,exported_at:at,supplier_price_items:items,supplier_price_imports:imports,
    supplier_catalog_copy:createSupplierCatalogManifest(tenant,at,items,imports)}
}
beforeEach(()=>{
  root=mkdtempSync(path.join(tmpdir(),'forsage-catalog-manifest-'))
  db=new LocalDatabase(root);sync=new LocalSyncRepository(db)
})
afterEach(()=>{
  db.close()
  if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-catalog-manifest-'))rmSync(root,{recursive:true,force:true})
})
const snap=()=>['supplier_price_items','supplier_price_imports','products','sync_outbox','sync_state','app_meta']
  .map(table=>db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all())
const routes=['sync','chunked','bootstrap','bootstrap-chunked','direct']
const apply=(route:string,input:any)=>Promise.resolve().then(()=>route==='sync'?sync.applyPullChanges(input)
  :route==='chunked'?sync.applyPullChangesChunked(input)
  :route==='bootstrap-chunked'?sync.importSnapshotChunked(input)
  :route==='bootstrap'?new LocalBootstrapRepository(db).importSnapshot(input)
  :new LocalBootstrapRepository(db).applySyncChanges(tenant,input))
it.each(routes)('accepts valid %s copy and repeats without duplicate rows',async route=>{
  const input=copy()
  await apply(route,input);await apply(route,input)
  expect(db.prepare('SELECT count(*) n FROM supplier_price_items').get()).toMatchObject({n:26})
  expect(db.prepare('SELECT count(*) n FROM supplier_price_imports').get()).toMatchObject({n:1})
  expect(db.prepare('SELECT count(*) n FROM sync_outbox').get()).toMatchObject({n:0})
})
const faults=['missing-item','missing-history','changed-price','changed-version','wrong-tenant','duplicate-id','wrong-cursor','wrong-version','bad-count','bad-hash','no-array','null-manifest']
it.each(routes.flatMap(route=>faults.map(fault=>({route,fault}))))
('rejects $route $fault before any data or cursor change',async({route,fault})=>{
  const input=copy(),m=input.supplier_catalog_copy
  if(fault==='missing-item')input.supplier_price_items.pop()
  if(fault==='missing-history')input.supplier_price_imports=[]
  if(fault==='changed-price')input.supplier_price_items[0].price_kopecks=777
  if(fault==='changed-version')input.supplier_price_items[0].updated_at='2026-10-09T11:00:00Z'
  if(fault==='wrong-tenant')input.supplier_price_items[0].tenant_id='foreign'
  if(fault==='duplicate-id')input.supplier_price_items[1].id=input.supplier_price_items[0].id
  if(fault==='wrong-cursor')m.cursor='2026-10-09T11:00:00Z'
  if(fault==='wrong-version')m.version=2
  if(fault==='bad-count')m.item_count='26'
  if(fault==='bad-hash')m.sha256='a'.repeat(64)
  if(fault==='no-array')delete input.supplier_price_items
  if(fault==='null-manifest')input.supplier_catalog_copy=null
  input.products=[{id:'untouched-product',tenant_id:tenant,sku:'UNTOUCHED',name:'Untouched',qty_on_hand:123}]
  const before=snap()
  await expect(apply(route,input)).rejects.toThrow()
  expect(snap()).toEqual(before)
})
it.each(routes)('does not delete existing catalog on a valid empty %s copy',async route=>{
  await apply(route,copy())
  const input={tenant_id:tenant,cursor:at,exported_at:at,supplier_price_items:[],supplier_price_imports:[],
    supplier_catalog_copy:createSupplierCatalogManifest(tenant,at,[],[])}
  await apply(route,input)
  expect(db.prepare('SELECT count(*) n FROM supplier_price_items').get()).toMatchObject({n:26})
})
it('accepts different JSON object key order but rejects changed values',()=>{
  const input=copy()
  input.supplier_price_items=input.supplier_price_items.map((row:any)=>Object.fromEntries(Object.entries(row).reverse()))
  expect(()=>validateSupplierCatalogManifest(input,tenant,at)).not.toThrow()
  input.supplier_price_items[0].qty='0.25'
  expect(()=>validateSupplierCatalogManifest(input,tenant,at)).toThrow()
})

it.each(routes)('accepts declared %s delta without treating missing IDs as deletion',async route=>{
  const input=copy()
  await apply(route,input)
  const items=[{...input.supplier_price_items[0],qty:'0.250',updated_at:'2026-10-09T11:00:00Z'}]
  const cursor='2026-10-09T12:00:00Z'
  const delta={tenant_id:tenant,cursor,exported_at:cursor,supplier_price_items:items,supplier_price_imports:[],
    supplier_catalog_copy:createSupplierCatalogManifest(tenant,cursor,items,[],at)}
  await apply(route,delta)
  expect(db.prepare('SELECT count(*) n FROM supplier_price_items').get()).toMatchObject({n:26})
  expect(db.prepare("SELECT qty FROM supplier_price_items WHERE id='price-0'").get()).toMatchObject({qty:0.25})
})
it.each(['missing','future','wrong-mode'])('rejects %s delta scope',fault=>{
  const input=copy()
  input.supplier_catalog_copy=createSupplierCatalogManifest(tenant,at,input.supplier_price_items,input.supplier_price_imports,'2026-10-08T00:00:00Z')
  if(fault==='missing')delete input.supplier_catalog_copy.since
  if(fault==='future')input.supplier_catalog_copy.since='2026-10-10T00:00:00Z'
  if(fault==='wrong-mode')input.supplier_catalog_copy.mode='full'
  expect(()=>validateSupplierCatalogManifest(input,tenant,at)).toThrow()
})


it.each(routes)('accepts %s historical price with an archived supplier kept archived',async route=>{
  const input=copy()
  const parent={id:'archived-supplier',tenant_id:tenant,name:'Archived',is_active:false,deleted_at:at,created_at:at,updated_at:at}
  input.suppliers=[parent]
  for(const row of [...input.supplier_price_items,...input.supplier_price_imports])row.supplier_id=parent.id
  input.supplier_catalog_copy=createSupplierCatalogManifest(tenant,at,input.supplier_price_items,input.supplier_price_imports)
  await apply(route,input)
  expect(db.prepare('SELECT is_active,deleted_at FROM suppliers').get()).toMatchObject({is_active:0,deleted_at:at})
  expect(db.prepare('SELECT count(*) n FROM supplier_price_items WHERE supplier_id=?').get(parent.id)).toMatchObject({n:26})
})

it('keeps legacy input compatible without pretending it has a complete-copy manifest',async()=>{
  const input=copy();delete input.supplier_catalog_copy
  await apply('chunked',input)
  expect(db.prepare('SELECT count(*) n FROM supplier_price_items').get()).toMatchObject({n:26})
})
