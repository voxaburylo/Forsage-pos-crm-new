import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { CatalogBatchRepository } from '../src/repositories/catalogBatchRepository'
let root: string, db: LocalDatabase, catalog: LocalCatalogRepository, batch: CatalogBatchRepository, ids: string[]
beforeEach(() => {
 root=mkdtempSync(path.join(tmpdir(),'forsage-batch-test-')); db=new LocalDatabase(root);catalog=new LocalCatalogRepository(db);batch=new CatalogBatchRepository(db,catalog)
 ids=[randomUUID(),randomUUID()]; for(const id of ids) catalog.saveProduct({id,sku:id,name:id,qty_on_hand:3,purchase_price:5000,retail_price:10000})
})
afterEach(() => {db.close(); if(path.dirname(root)===path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-batch-test-')) rmSync(root,{recursive:true,force:true})})
it('rolls back all import rows and replays a committed import once', () => {
 const input={operation_id:randomUUID(),kind:'import' as const,payload:{mode:'add',items:ids.map((id,row)=>({row,product_id:id,sku:id,name:id,qty:2,price:5000}))}}
 const original=catalog.saveProduct.bind(catalog); let calls=0
 const mock=vi.spyOn(catalog,'saveProduct').mockImplementation((p,o)=>{if(++calls===2)throw Error('disk fault');return original(p,o)})
 expect(()=>batch.apply(input)).toThrow('disk fault'); expect(ids.map(id=>catalog.findById(id)?.qty_on_hand)).toEqual([3,3]);mock.mockRestore()
 const result=batch.apply(input);expect(batch.apply(input)).toEqual(result); expect(ids.map(id=>catalog.findById(id)?.qty_on_hand)).toEqual([5,5])
})
it('rolls back partial price updates and never compounds a replayed percentage',()=>{
 const input={operation_id:randomUUID(),kind:'bulk' as const,payload:{productIds:ids,updates:{retail_price_action:{type:'percent',value:10}}}}
 const original=catalog.saveProduct.bind(catalog);let calls=0;const mock=vi.spyOn(catalog,'saveProduct').mockImplementation((p,o)=>{if(++calls===2)throw Error('disk fault');return original(p,o)})
 expect(()=>batch.apply(input)).toThrow();expect(ids.map(id=>catalog.findById(id)?.retail_price)).toEqual([10000,10000]);mock.mockRestore()
 batch.apply(input); batch.apply(input);expect(ids.map(id=>catalog.findById(id)?.retail_price)).toEqual([11000,11000])
})
it('rejects changed replay and invalid quantities without changing stock',()=>{
 const input={operation_id:randomUUID(),kind:'import' as const,payload:{mode:'add',items:[{row:1,product_id:ids[0],qty:2,price:5000}]}}
 batch.apply(input);expect(()=>batch.apply({...input,payload:{...input.payload,mode:'replace'}})).toThrow('інші дані')
 expect(()=>batch.apply({...input,operation_id:randomUUID(),payload:{items:[{row:1,product_id:ids[0],qty:NaN,price:5000}]}})).toThrow('Некоректна')
 expect(catalog.findById(ids[0])?.qty_on_hand).toBe(5)
})
