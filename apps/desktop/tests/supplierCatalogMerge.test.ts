import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach,afterEach,it,expect } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import { LocalSupplierCatalogRepository } from '../src/repositories/supplierCatalogRepository'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { supplierMergeReceiptKey } from '../src/repositories/supplierMergeSafety'

let root:string,db:LocalDatabase,supply:LocalSupplyRepository,catalog:LocalSupplierCatalogRepository,source:string,target:string
const at='2026-10-10T09:00:00.000Z'
beforeEach(()=>{
  root=mkdtempSync(path.join(tmpdir(),'forsage-catalog-merge-'));db=new LocalDatabase(root)
  supply=new LocalSupplyRepository(db);catalog=new LocalSupplierCatalogRepository(db)
  source=supply.saveSupplier({name:'Дублікат'}).id;target=supply.saveSupplier({name:'Основний'}).id
  db.prepare('INSERT INTO products(id,tenant_id,sku,name,qty_on_hand,created_at,updated_at) VALUES(?,?,?,?,7,?,?)')
    .run('product',tenant,'STOCK','Залишки',at,at)
})
afterEach(()=>{
  db.close()
  if (path.dirname(root)===path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-catalog-merge-')) rmSync(root,{recursive:true,force:true})
})
const snapshot=()=>Object.fromEntries((db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[])
  .map(({name})=>[name,db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()]))
const merge=()=>supply.mergeSuppliers(target,source)
const item=(extra:Record<string,unknown>={})=>catalog.create({supplier_id:source,sku:'SKU-'+randomUUID(),name:'Назва '+randomUUID(),qty:'1.25',price_kopecks:1200,...extra})
const imported=()=>{
  const options={supplier_id:source,mode:'add' as const,operation_id:'attempt',user_id:'owner'}
  const rows=[{source_row:1,sku:'IMPORT-1',name:'Імпорт',qty:'2.125',price_kopecks:777}]
  const result=catalog.importRows('price.csv',rows,options)
  return {result,options,rows}
}
const receipt=()=>JSON.parse((db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(supplierMergeReceiptKey(tenant,source)) as any).value_json)
const restart=()=>{db.close();db=new LocalDatabase(root);supply=new LocalSupplyRepository(db);catalog=new LocalSupplierCatalogRepository(db)}
it('moves price/history/paid documents in one commit without changing stock, prices or old outbox requests',()=>{
  const row=item(),im=imported(),existing=item({supplier_id:target})
  const invoice=supply.createInvoice({supplier_id:source,paid_amount:100,payment_method:'cash',fund_source:'owner_funds',
    items:[{product_id:'product',qty:2,purchase_price:100}]})
  const stock=db.prepare('SELECT * FROM products').all(),old=db.prepare('SELECT * FROM sync_outbox ORDER BY sequence').all()
  const before=db.prepare('SELECT * FROM supplier_price_items WHERE id=?').get(row.id) as any
  merge()
  const saved=receipt()
  expect(saved.history_payload.catalog).toMatchObject({version:1,items:expect.arrayContaining([expect.objectContaining({id:row.id,qty:'1.25',price_kopecks:1200})]),
    imports:[expect.objectContaining({id:im.result.importId,mode:'add',total_rows:1,processed_rows:1})]})
  expect(db.prepare('SELECT * FROM supplier_price_items WHERE id=?').get(row.id)).toMatchObject({...before,supplier_id:target,dirty_at:expect.any(String),updated_at:expect.any(String)})
  expect(catalog.list({supplier_id:target}).data).toHaveLength(3)
  expect(catalog.list({supplier_id:target}).data.find(x=>x.id===existing.id)).toEqual(existing)
  expect(supply.getInvoice(invoice.id).supplier_id).toBe(target)
  expect(db.prepare('SELECT * FROM products').all()).toEqual(stock)
  expect(db.prepare('SELECT * FROM sync_outbox ORDER BY sequence LIMIT ?').all(old.length)).toEqual(old)
  expect(db.prepare("SELECT * FROM sync_outbox WHERE operation_type='supplier.merged'").all()).toHaveLength(1)
  const current=snapshot();expect(merge()).toEqual(supply.getSupplier(target));expect(snapshot()).toEqual(current)
})
it.each(['items','imports','deleted','unknown scope'])('handles %s without fabricating invoice history',kind=>{
  const row=item(),im=imported()
  if(kind==='items')db.exec('DELETE FROM supplier_price_imports')
  if(kind==='imports')db.exec('DELETE FROM supplier_price_items')
  if(kind==='deleted'){catalog.delete(row.id);db.prepare('UPDATE supplier_price_imports SET deleted_at=?').run(at)}
  if(kind==='unknown scope')db.exec('UPDATE supplier_price_imports SET scope_known=0')
  merge();expect(receipt().history_payload.invoices).toEqual([])
  if(kind==='unknown scope')expect(receipt().history_payload.catalog.imports[0].mode).toBeNull()
  if(kind==='deleted')expect(receipt().history_payload.catalog.items.find((x:any)=>x.id===row.id).deleted_at).not.toBeNull()
  restart();const before=snapshot();merge();expect(snapshot()).toEqual(before)
})
it('keeps import retries immutable after a merge, newer changes, deletion, and queue cleanup',()=>{
  const im=imported();merge()
  const row=catalog.list({supplier_id:target}).data[0]
  catalog.update(row.id,{price_kopecks:9999,qty:'7'});catalog.delete(row.id)
  db.exec('DELETE FROM sync_outbox');restart()
  const before=snapshot();expect(catalog.importRows('price.csv',im.rows,im.options)).toEqual(im.result)
  merge();expect(snapshot()).toEqual(before)
})
it('follows two merges, explicit moves, unassigned scope and a return without guessing',()=>{
  const row=item(),third=supply.saveSupplier({name:'Третій'}).id,fourth=supply.saveSupplier({name:'Четвертий'}).id
  merge();catalog.update(row.id,{supplier_id:third});supply.mergeSuppliers(fourth,third)
  catalog.update(row.id,{supplier_id:null});catalog.update(row.id,{supplier_id:target})
  db.exec('DELETE FROM sync_outbox');restart()
  const before=snapshot();merge();supply.mergeSuppliers(fourth,third);expect(snapshot()).toEqual(before)
})
it('starts provenance from its merge offset, not from edits before the merge',()=>{
  const row=item({supplier_id:target})
  catalog.update(row.id,{supplier_id:source});merge();catalog.update(row.id,{supplier_id:null})
  restart();const before=snapshot();merge();expect(snapshot()).toEqual(before)
  expect(receipt().catalog_supplier_change_offsets[row.id]).toBe(1)
})
it.each(['sku','barcode','name'])('rejects %s collisions before writing',field=>{
  const a=item({barcode:'1234567890123'})
  item({supplier_id:target,[field]:a[field as keyof typeof a]})
  const before=snapshot();expect(merge).toThrow(/Спочатку звірте/);expect(snapshot()).toEqual(before)
})
it('keeps the same identity in separate warehouses without adding quantities',()=>{
  const a=item({warehouse_name:'A'});item({supplier_id:target,sku:a.sku,name:a.name,warehouse_name:'B'})
  merge();expect(catalog.list({supplier_id:target}).data.map(x=>x.qty)).toEqual(['1.25','1.25'])
})
it.each(['pending','processing','bad errors','extra errors key','invalid date','negative price','invalid quantity','foreign item','foreign import','non uuid','missing sku'])('rejects malformed %s atomically',kind=>{
  const a=item();imported()
  if(['pending','processing'].includes(kind))db.prepare('UPDATE supplier_price_imports SET status=?').run(kind)
  if(kind==='bad errors')db.exec("UPDATE supplier_price_imports SET errors_json='{}'")
  if(kind==='extra errors key')db.prepare('UPDATE supplier_price_imports SET errors_json=?').run(JSON.stringify([{row:1,error:'bad',extra:1}]))
  if(kind==='invalid date')db.exec("UPDATE supplier_price_items SET created_at='not-date'")
  if(kind==='negative price')db.exec('UPDATE supplier_price_items SET price_kopecks=-1')
  if(kind==='invalid quantity')db.exec('UPDATE supplier_price_items SET qty=1.1234')
  if(kind==='foreign item')db.prepare("UPDATE supplier_price_items SET tenant_id='other' WHERE id=?").run(a.id)
  if(kind==='foreign import')db.exec("UPDATE supplier_price_imports SET tenant_id='other'")
  if(kind==='non uuid')db.prepare("UPDATE supplier_price_items SET id='invalid' WHERE id=?").run(a.id)
  if(kind==='missing sku')db.prepare("UPDATE supplier_price_items SET sku='' WHERE id=?").run(a.id)
  const before=snapshot();expect(merge).toThrow();expect(snapshot()).toEqual(before)
})
it.each(['item','import','outbox','receipt','source','late item','target item','late import','stock trigger'])('rolls back skipped/corrupted %s writes including receipts and balances',kind=>{
  item();imported();item({supplier_id:target})
  let statement:string
  if(kind==='item')statement='BEFORE UPDATE ON supplier_price_items BEGIN SELECT RAISE(IGNORE); END'
  else if(kind==='import')statement='BEFORE UPDATE ON supplier_price_imports BEGIN SELECT RAISE(IGNORE); END'
  else if(kind==='outbox')statement="BEFORE INSERT ON sync_outbox WHEN NEW.operation_type='supplier.merged' BEGIN SELECT RAISE(IGNORE); END"
  else if(kind==='receipt')statement="BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'supplier-merge:%' BEGIN SELECT RAISE(IGNORE); END"
  else if(kind==='source')statement="BEFORE UPDATE ON suppliers BEGIN SELECT RAISE(IGNORE); END"
  else if(kind==='stock trigger')statement='AFTER UPDATE ON supplier_price_items BEGIN UPDATE products SET qty_on_hand=qty_on_hand+1; END'
  else statement="AFTER INSERT ON app_meta WHEN NEW.key LIKE 'supplier-merge:%' BEGIN UPDATE "+(kind==='late import'?'supplier_price_imports SET filename=\'changed\'':'supplier_price_items SET price_kopecks=price_kopecks+1')+"; END"
  db.exec('CREATE TRIGGER corrupt_merge '+statement)
  const before=snapshot();expect(merge).toThrow();expect(snapshot()).toEqual(before)
  db.exec('DROP TRIGGER corrupt_merge');merge()
})
it.each(['missing item','foreign','unproven move','missing chain','missing edit proof','bad offset','cycle'])('rejects damaged retry %s without repairing by guess',kind=>{
  const row=item(),third=supply.saveSupplier({name:'Третій'}).id;merge()
  if(kind==='missing item')db.prepare('DELETE FROM supplier_price_items WHERE id=?').run(row.id)
  if(kind==='foreign')db.prepare("UPDATE supplier_price_items SET tenant_id='other' WHERE id=?").run(row.id)
  if(kind==='unproven move')db.prepare('UPDATE supplier_price_items SET supplier_id=? WHERE id=?').run(third,row.id)
  if(kind==='missing chain'){supply.mergeSuppliers(third,target);db.prepare('DELETE FROM app_meta WHERE key=?').run(supplierMergeReceiptKey(tenant,target))}
  if(kind==='missing edit proof'){catalog.update(row.id,{supplier_id:third});db.prepare('DELETE FROM app_meta WHERE key=?').run('catalog-supplier-changes:'+tenant+':'+row.id)}
  if(kind==='bad offset'){const r=receipt();r.catalog_supplier_change_offsets[row.id]=99;db.prepare('UPDATE app_meta SET value_json=? WHERE key=?').run(JSON.stringify(r),supplierMergeReceiptKey(tenant,source))}
  if(kind==='cycle'){supply.mergeSuppliers(third,target);db.prepare("UPDATE app_meta SET value_json=json_set(value_json,'$.target',?,'$.result.id',?,'$.history_payload.primary_supplier_id',?) WHERE key=?").run(target,target,target,supplierMergeReceiptKey(tenant,target))}
  const before=snapshot();expect(merge).toThrow();expect(snapshot()).toEqual(before)
})
it.each(['skip','corrupt','late corruption'])('rolls back manual supplier edit if durable proof is %s',kind=>{
  const row=item()
  const key='catalog-supplier-changes:'+tenant+':'+row.id
  const trigger=kind==='skip'?"BEFORE INSERT ON app_meta WHEN NEW.key='"+key+"' BEGIN SELECT RAISE(IGNORE); END"
    :kind==='corrupt'?"AFTER INSERT ON app_meta WHEN NEW.key='"+key+"' BEGIN UPDATE app_meta SET value_json='{}' WHERE key=NEW.key; END"
    :"AFTER INSERT ON sync_outbox WHEN NEW.operation_type='supplier_catalog.item_upserted' BEGIN DELETE FROM app_meta WHERE key='"+key+"'; END"
  db.exec('CREATE TRIGGER damage_change '+trigger)
  const before=snapshot();expect(()=>catalog.update(row.id,{supplier_id:target})).toThrow();expect(snapshot()).toEqual(before)
})

it('keeps completed, cancelled and deleted invoice histories atomic with price lists',()=>{
  item()
  const make=()=>supply.createInvoice({supplier_id:source,items:[{product_id:'product',qty:1,purchase_price:100}]})
  const posted=make(),cancelled=make(),deleted=make()
  supply.postInvoice(posted.id);supply.cancelInvoice(cancelled.id);supply.deleteInvoice(deleted.id)
  const stock=db.prepare('SELECT * FROM products').all()
  merge();restart();const before=snapshot();merge();expect(snapshot()).toEqual(before)
  expect(db.prepare('SELECT * FROM products').all()).toEqual(stock)
})
it.each(['late stock','old request','unrelated history'])('rolls back an unexpected %s write from a late trigger',kind=>{
  item();imported()
  const extra=kind==='late stock'?'UPDATE products SET qty_on_hand=qty_on_hand+1;'
    :kind==='old request'?"UPDATE sync_outbox SET payload_json='{}' WHERE operation_type='supplier_catalog.imported';"
    :"INSERT INTO app_meta(key,value_json,updated_at) VALUES('unexpected','{}','2026-10-10');"
  db.exec("CREATE TRIGGER extra_write AFTER INSERT ON app_meta WHEN NEW.key LIKE 'supplier-merge:%' BEGIN "+extra+" END")
  const before=snapshot();expect(merge).toThrow();expect(snapshot()).toEqual(before)
})
it('rejects a manifest over one megabyte without a partial merge',()=>{
  item({name:'A'.repeat(600000)});item({name:'B'.repeat(600000)})
  const before=snapshot();expect(merge).toThrow(/надто велика/);expect(snapshot()).toEqual(before)
})
it('keeps unknown foreign-key dependencies blocked even with a known catalog',()=>{
  item()
  db.exec('CREATE TABLE extra_supplier_ref(id TEXT,vendor_id TEXT REFERENCES suppliers(id))')
  db.prepare('INSERT INTO extra_supplier_ref VALUES(?,?)').run('ref',source)
  const before=snapshot();expect(merge).toThrow();expect(snapshot()).toEqual(before)
})

it('handles 500 distinct rows with history and repeated merges after restart',()=>{
  const rows=Array.from({length:500},(_,i)=>({source_row:i+1,sku:'BULK-'+i,name:'Bulk '+i,qty:'0.125',price_kopecks:100+i}))
  catalog.importRows('bulk.csv',rows,{supplier_id:source,mode:'add'})
  const third=supply.saveSupplier({name:'Третій'}).id
  merge();supply.mergeSuppliers(third,target);restart()
  const before=snapshot();merge();expect(snapshot()).toEqual(before)
  expect(catalog.list({supplier_id:third,limit:1000}).data).toHaveLength(500)
})
