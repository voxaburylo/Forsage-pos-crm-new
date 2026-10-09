import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ db: null as any, alter: null as any, fail: false, queries: [] as any[] }))
vi.mock('../../db/pg.js', () => ({ pool: { query: async (sql: string, args: unknown[]) => {
  state.queries.push({ sql, args })
  if (state.fail) throw new Error('fixture database unavailable')
  const result = await state.db.query(sql, args)
  return state.alter ? state.alter(result) : result
} } }))
import { fetchSupplierCatalogCopy, mergeCatalogSupplierParents } from '../sync/supplierCatalogCopy.js'
import { validateSupplierCatalogManifest } from '../../lib/supplierCatalogManifest.js'
import { syncFunctionBody } from './helpers/syncSource.js'

const tenant = '00000000-0000-4000-8000-000000000001', foreign = '00000000-0000-4000-8000-000000000002'
const at = '2026-10-09T10:00:00.000Z'
beforeAll(async () => {
  state.db = new PGlite()
  await state.db.exec(`
    CREATE TABLE suppliers(id uuid PRIMARY KEY,tenant_id uuid,name text,phone text,email text,contact_name text,
      notes text,is_active boolean,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz);
    CREATE TABLE supplier_price_items (
      id uuid PRIMARY KEY,tenant_id uuid,supplier_id uuid,sku text,barcode text,brand text,name text,
      price_kopecks bigint,qty numeric(18,3),warehouse_name text,
      created_at timestamptz,updated_at timestamptz,deleted_at timestamptz
    );
    CREATE TABLE supplier_price_imports (
      id uuid PRIMARY KEY,tenant_id uuid,supplier_id uuid,filename text,mode text,warehouse_name text,
      status text,total_rows integer,processed_rows integer,errors_log jsonb,
      created_at timestamptz,updated_at timestamptz
    );
  `)
})
afterAll(async () => state.db.close())
beforeEach(async () => {
  state.alter=null; state.fail=false; state.queries=[]
  await state.db.exec('TRUNCATE supplier_price_items,supplier_price_imports,suppliers')
})
async function seed(n=1, tenantId=tenant) {
  await state.db.query(`
    INSERT INTO supplier_price_items
    SELECT (md5($1::text || i::text))::uuid,$1::uuid,NULL,'SKU-'||i,NULL,'WIX','Filter '||i,
      12000,0.125,'Main','2026-10-08','2026-10-08',NULL
    FROM generate_series(1,$2::int) i
  `,[tenantId,n])
  await state.db.query(`
    INSERT INTO supplier_price_imports VALUES
    (md5($1::text)::uuid,$1::uuid,NULL,'price.csv','replace','Main','completed',$2,$2,'[]','2026-10-08','2026-10-08')
  `,[tenantId,n])
}
it.each(['owner','admin'])('reads complete catalog and history in one SQL statement for %s', async role => {
  await seed(2501)
  const {data:value}=await fetchSupplierCatalogCopy(tenant,at,role)
  expect(state.queries).toHaveLength(1)
  expect(value.supplier_price_items).toHaveLength(2501)
  expect(value.supplier_price_imports).toHaveLength(1)
  expect(value.supplier_catalog_copy?.item_count).toBe(2501)
  validateSupplierCatalogManifest(value,tenant,at)
})
it.each(['cashier','manager','storekeeper','tire_worker','sto_viewer','unknown'])('does not access supplier prices for %s', async role => {
  const result = await fetchSupplierCatalogCopy(tenant,at,role)
  expect(result).toMatchObject({data:{supplier_price_items:[],supplier_price_imports:[],
    supplier_catalog_copy:{version:1,tenant_id:tenant,item_count:0,import_count:0}},parents:[]})
  validateSupplierCatalogManifest(result.data,tenant,at)
  expect(state.queries).toHaveLength(0)
})
it.each(['cashier','manager'])('provides a verifiable empty delta for %s without reading commercial data', async role => {
  const since='2026-10-08T10:00:00Z'
  const {data:value}=await fetchSupplierCatalogCopy(tenant,at,role,since)
  expect(value.supplier_catalog_copy).toMatchObject({version:1,mode:'delta',since,item_count:0,import_count:0})
  validateSupplierCatalogManifest(value,tenant,at)
  expect(state.queries).toHaveLength(0)
})
it('isolates both tables by tenant and never includes unrelated commercial data', async () => {
  await seed(2);await seed(3,foreign)
  const {data:value}=await fetchSupplierCatalogCopy(tenant,at,'owner')
  expect(value.supplier_price_items).toHaveLength(2)
  expect(value.supplier_price_imports).toHaveLength(1)
  expect([...value.supplier_price_items,...value.supplier_price_imports].every((r:any)=>r.tenant_id===tenant)).toBe(true)
  expect(state.queries[0].args).toEqual([tenant,null])
})
it.each(["'; SELECT 1; --",'','not-a-tenant'])('rejects invalid tenant %s before querying', async scope => {
  await expect(fetchSupplierCatalogCopy(scope,at,'owner')).rejects.toThrow()
  expect(state.queries).toHaveLength(0)
})
it('preserves fractional quantities, scope, microsecond versions and deleted items', async () => {
  await seed()
  await state.db.exec("UPDATE supplier_price_items SET qty=123456789012.125,updated_at='2026-10-09T11:00:00.123456Z',deleted_at='2026-10-09T11:00:00Z'")
  const {data:value}=await fetchSupplierCatalogCopy(tenant,at,'owner')
  expect(value.supplier_price_items[0].qty).toBe('123456789012.125')
  expect(value.supplier_price_items[0].updated_at).toContain('.123456')
  expect(value.supplier_price_items[0].deleted_at).toBeTruthy()
  expect(value.supplier_price_imports[0]).toMatchObject({mode:'replace',warehouse_name:'Main'})
})
it('includes both old timestamp late commits and writes newer than the main request cursor', async () => {
  await seed(2)
  await state.db.exec("UPDATE supplier_price_items SET updated_at='2026-10-09T11:00:00Z' WHERE sku='SKU-2'")
  const {data:value}=await fetchSupplierCatalogCopy(tenant,at,'owner')
  expect(value.supplier_price_items).toHaveLength(2)
  expect(value.supplier_catalog_copy?.mode).toBe('full')
})
it('returns a verifiable empty snapshot', async () => {
  const {data:value}=await fetchSupplierCatalogCopy(tenant,at,'owner')
  expect(value.supplier_catalog_copy).toMatchObject({item_count:0,import_count:0})
  validateSupplierCatalogManifest(value,tenant,at)
})
it.each(['missing-row','missing-history','wrong-count','no-array','duplicate','foreign','extra-result'])
('rejects a %s database response without a successful manifest', async fault => {
  await seed(2)
  state.alter=(result:any)=>{
    const row=result.rows[0]
    if(fault==='missing-row')row.items.pop()
    if(fault==='missing-history')row.imports=[]
    if(fault==='wrong-count')row.item_count='999'
    if(fault==='no-array')row.items=null
    if(fault==='duplicate')row.items[1]=row.items[0]
    if(fault==='foreign')row.items[0].tenant_id=foreign
    if(fault==='extra-result')result.rows.push(row)
    return result
  }
  await expect(fetchSupplierCatalogCopy(tenant,at,'owner')).rejects.toThrow()
  expect(state.queries).toHaveLength(1)
})
it('propagates database failure without falling back to independent REST reads', async () => {
  state.fail=true
  await expect(fetchSupplierCatalogCopy(tenant,at,'owner')).rejects.toThrow('fixture database unavailable')
  expect(state.queries).toHaveLength(1)
})
it('uses the same complete copy service for bootstrap and regular pull', () => {
  for (const name of ['getSyncChanges','getBootstrapSnapshot']) {
    const body=syncFunctionBody(name)
    expect(body).toContain('fetchSupplierCatalogCopy(tenantId,')
    expect(body).toContain('...supplierCatalogCopy')
    expect(body).not.toContain(".from('supplier_price_items')")
    expect(body).not.toContain(".from('supplier_price_imports')")
  }
})

it('declares a delta and retains only changes after its lower bound in the same snapshot',async()=>{
  await seed(2)
  await state.db.exec("UPDATE supplier_price_items SET updated_at='2026-10-09T11:00:00Z' WHERE sku='SKU-2'")
  const since='2026-10-09T09:00:00Z'
  const {data:value}=await fetchSupplierCatalogCopy(tenant,at,'owner',since)
  expect(value.supplier_price_items).toHaveLength(1)
  expect(value.supplier_price_items[0].sku).toBe('SKU-2')
  expect(value.supplier_price_imports).toHaveLength(0)
  expect(value.supplier_catalog_copy).toMatchObject({mode:'delta',since,item_count:1,import_count:0})
  validateSupplierCatalogManifest(value,tenant,at)
  expect(state.queries).toHaveLength(1)
})
it.each(['invalid','2026-10-10T00:00:00Z'])('rejects invalid delta bound %s before reading',async since=>{
  await expect(fetchSupplierCatalogCopy(tenant,at,'owner',since)).rejects.toThrow()
  expect(state.queries).toHaveLength(0)
})
it('requests full catalog on reference refresh, not on every incremental pull',()=>{
  expect(syncFunctionBody('getSyncChanges')).toContain('fetchSupplierCatalogCopy(tenantId, nextCursor, role, referencesIncluded ? undefined : since)')
})


it('includes an archived supplier required by price history without restoring it',async()=>{
  await seed()
  await state.db.query("INSERT INTO suppliers(id,tenant_id,name,is_active,created_at,updated_at,deleted_at) VALUES($1,$2,'Archived',false,'2026-10-08','2026-10-08','2026-10-08')",[foreign,tenant])
  await state.db.query('UPDATE supplier_price_items SET supplier_id=$1',[foreign])
  await state.db.query('UPDATE supplier_price_imports SET supplier_id=$1',[foreign])
  const value=await fetchSupplierCatalogCopy(tenant,at,'owner')
  expect(value.parents).toHaveLength(1)
  expect(value.parents[0]).toMatchObject({id:foreign,is_active:false})
  expect(value.parents[0].deleted_at).toBeTruthy()
  const merged=mergeCatalogSupplierParents([{id:foreign,name:'Stale active'},{id:'unrelated',name:'Other'}],value.parents)
  expect(merged).toHaveLength(2)
  expect(merged.find(row=>row.id===foreign)).toMatchObject({name:'Archived',is_active:false})
  expect(state.queries).toHaveLength(1)
})
it.each(['missing','foreign'])('rejects a %s supplier reference instead of dropping its history',async kind=>{
  await seed()
  await state.db.query('UPDATE supplier_price_imports SET supplier_id=$1',[foreign])
  if(kind==='foreign') await state.db.query("INSERT INTO suppliers(id,tenant_id,name) VALUES($1,$2,'Private')",[foreign,foreign])
  await expect(fetchSupplierCatalogCopy(tenant,at,'owner')).rejects.toThrow()
})
it('takes restored or archived supplier state from the later coherent catalog snapshot',()=>{
  const merged=mergeCatalogSupplierParents(
    [{id:'restored',deleted_at:'old'},{id:'archived',deleted_at:null}],
    [{id:'restored',deleted_at:null},{id:'archived',deleted_at:'new'}])
  expect(merged.filter(row=>row.deleted_at).map(row=>row.id)).toEqual(['archived'])
})
it('does not mutate the primary supplier array when adding snapshot dependencies',()=>{
  const original=[{id:'a',name:'A'}],parents=[{id:'b',name:'B'}]
  expect(mergeCatalogSupplierParents(original,parents)).toEqual([...original,...parents])
  expect(original).toEqual([{id:'a',name:'A'}])
})

it('keeps server and desktop integrity protocols identical', () => {
  const server=readFileSync(new URL('../../lib/supplierCatalogManifest.ts',import.meta.url),'utf8')
  const desktop=readFileSync(new URL('../../../../apps/desktop/src/lib/supplierCatalogManifest.ts',import.meta.url),'utf8')
  expect(server.replace(/\r\n/g,'\n')).toBe(desktop.replace(/\r\n/g,'\n'))
})
