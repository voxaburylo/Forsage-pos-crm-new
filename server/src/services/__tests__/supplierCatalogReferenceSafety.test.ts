import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ db: null as any, queries: [] as string[] }))
vi.mock('../../db/pg.js', () => ({ runTransaction: (fn: any) => state.db.transaction((tx: any) => fn({
  query: async (sql: string, args: any[]) => {
    state.queries.push(sql)
    const result = await tx.query(sql,args)
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }
  },
})) }))
import { applySupplierCatalogImported, applySupplierCatalogItemUpsert } from '../supplierCatalogSyncService.js'
const tenant=randomUUID(), supplier=randomUUID(), itemId=randomUUID(), importId=randomUUID(), at='2026-10-07T06:00:00Z'
const row = () => ({ id:itemId, supplier_id:supplier, sku:'TEST', name:'Test product', price_kopecks:12000, qty:'2' })
const operation = ():any => ({ aggregate_id:importId, created_at:at, payload:{ import:{id:importId,supplier_id:supplier,filename:'test.csv'}, mode:'replace',items:[row()] } })
const rows = async (sql:string,args:any[]=[]) => (await state.db.query(sql,args)).rows
const snap = async () => [await rows('SELECT * FROM supplier_price_items ORDER BY id'),await rows('SELECT * FROM supplier_price_imports ORDER BY id'),await rows('SELECT * FROM suppliers ORDER BY id')]
beforeAll(async()=>{
  state.db=new PGlite()
  await state.db.exec(`
    CREATE TABLE suppliers(id uuid PRIMARY KEY,tenant_id uuid,name text,is_active boolean DEFAULT true,deleted_at timestamptz);
    CREATE TABLE supplier_price_items(id uuid PRIMARY KEY,tenant_id uuid,supplier_id uuid REFERENCES suppliers,sku text,barcode text,brand text,name text,price_kopecks int,qty text,warehouse_name text,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz);
    CREATE TABLE supplier_price_imports(id uuid PRIMARY KEY,tenant_id uuid,supplier_id uuid REFERENCES suppliers,filename text,status text,total_rows int,processed_rows int,errors_log jsonb,created_at timestamptz,updated_at timestamptz);
  `)
})
afterAll(async()=>state.db.close())
beforeEach(async()=>{
  await state.db.exec('TRUNCATE supplier_price_imports,supplier_price_items,suppliers CASCADE')
  await state.db.query('INSERT INTO suppliers(id,tenant_id,name) VALUES($1,$2,$3)',[supplier,tenant,'Supplier'])
  await state.db.query('INSERT INTO supplier_price_items(id,tenant_id,sku,name) VALUES($1,$2,$3,$4)',[randomUUID(),tenant,'UNASSIGNED','Unassigned product'])
  state.queries=[]
})
it.each(['broken-id',123,{},false])('rejects malformed supplier reference %j before replace can touch unassigned items',async bad=>{
  const op=operation();op.payload.import.supplier_id=bad
  const before=await snap()
  await expect(applySupplierCatalogImported(tenant,op)).rejects.toThrow(/постачальник/i)
  expect(await snap()).toEqual(before)
})
it.each(['deleted','inactive','foreign','missing'])('rejects %s supplier without any price list changes',async kind=>{
  if(kind==='deleted') await state.db.query('UPDATE suppliers SET deleted_at=$1',[at])
  if(kind==='inactive') await state.db.exec('UPDATE suppliers SET is_active=false')
  if(kind==='foreign') await state.db.query('UPDATE suppliers SET tenant_id=$1',[randomUUID()])
  if(kind==='missing') await state.db.exec('DELETE FROM suppliers')
  const before=await snap()
  await expect(applySupplierCatalogImported(tenant,operation())).rejects.toThrow(/Постачальника/)
  expect(await snap()).toEqual(before)
})
it('also rejects invalid supplier identity on a single item',async()=>{
  const before=await snap()
  await expect(applySupplierCatalogItemUpsert(tenant,{aggregate_id:itemId,created_at:at,payload:{...row(),supplier_id:'broken'}})).rejects.toThrow(/постачальник/i)
  expect(await snap()).toEqual(before)
})
it('locks the active supplier before writing price items so merge cannot retire it between check and insert',async()=>{
  await applySupplierCatalogImported(tenant,operation())
  const checked=state.queries.findIndex(sql=>/FROM suppliers/.test(sql))
  const written=state.queries.findIndex(sql=>/UPDATE supplier_price_items/.test(sql))
  expect(checked).toBeGreaterThanOrEqual(0);expect(written).toBeGreaterThan(checked)
  expect(state.queries[checked]).toMatch(/FOR SHARE/i)
  expect(await rows('SELECT supplier_id FROM supplier_price_items WHERE id=$1',[itemId])).toEqual([{supplier_id:supplier}])
  expect(await rows('SELECT id FROM supplier_price_items WHERE supplier_id IS NULL AND deleted_at IS NULL')).toHaveLength(1)
})
it('allows an explicitly unassigned import without inventing a supplier',async()=>{
  const op=operation();op.payload.import.supplier_id=null
  await applySupplierCatalogImported(tenant,op)
  expect(await rows('SELECT supplier_id FROM supplier_price_imports')).toEqual([{supplier_id:null}])
})
