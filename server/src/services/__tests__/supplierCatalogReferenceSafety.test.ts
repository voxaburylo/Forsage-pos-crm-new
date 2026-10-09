import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ db: null as any, queries: [] as string[] }))
vi.mock('../../db/pg.js', () => ({ runTransaction: (fn: any) => state.db.transaction((tx: any) => fn({
  query: async (sql: string, args: any[]) => {
    state.queries.push(sql)
    const result = await tx.query(sql,args)
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }
  },
})) }))
import { applySupplierCatalogImported, applySupplierCatalogItemUpsert, applySupplierCatalogItemDeleted } from '../supplierCatalogSyncService.js'
import { lockCatalogCopy, saveCatalogReceipt } from '../supplierCatalogReceipt.js'

it.each(['upsert','delete','import add','import replace'])('rejects a foreign item ID during %s without any partial change', async action => {
  await state.db.query('INSERT INTO supplier_price_items(id,tenant_id,sku,name) VALUES($1,$2,$3,$4)', [itemId,randomUUID(),'FOREIGN','Private item'])
  const before = await snap()
  const op = operation()
  op.payload.mode = action === 'import add' ? 'add' : 'replace'
  await expect(action === 'upsert'
    ? applySupplierCatalogItemUpsert(tenant,{...metadata('supplier_catalog.item_upserted'),aggregate_id:itemId,created_at:at,payload:row()})
    : action === 'delete'
      ? applySupplierCatalogItemDeleted(tenant,{...metadata('supplier_catalog.item_deleted'),aggregate_id:itemId,created_at:at,payload:{id:itemId}})
      : applySupplierCatalogImported(tenant,op)).rejects.toThrow()
  expect(await snap()).toEqual(before)
})
it('rolls back replaced rows when the import ID is already owned by another tenant', async () => {
  await state.db.query('INSERT INTO supplier_price_imports(id,tenant_id,filename) VALUES($1,$2,$3)',[importId,randomUUID(),'foreign.csv'])
  await state.db.query('INSERT INTO supplier_price_items(id,tenant_id,supplier_id,sku,name) VALUES($1,$2,$3,$4,$5)',[randomUUID(),tenant,supplier,'OLD','Existing price'])
  const before = await snap()
  await expect(applySupplierCatalogImported(tenant,operation())).rejects.toThrow()
  expect(await snap()).toEqual(before)
})
it.each(['item','import','delete'])('rejects a different payload and operation ID for %s', async kind => {
  const before = await snap()
  const op = operation()
  op.aggregate_id = randomUUID()
  await expect(kind === 'import' ? applySupplierCatalogImported(tenant,op)
    : kind === 'item' ? applySupplierCatalogItemUpsert(tenant,{...metadata('supplier_catalog.item_upserted'),aggregate_id:op.aggregate_id,created_at:at,payload:row()})
      : applySupplierCatalogItemDeleted(tenant,{...metadata('supplier_catalog.item_deleted'),aggregate_id:op.aggregate_id,created_at:at,payload:{id:itemId}})).rejects.toThrow()
  expect(await snap()).toEqual(before)
})
it.each(['supplier','warehouse'])('does not steal item IDs from a different %s scope during replace', async kind => {
  await state.db.query('INSERT INTO supplier_price_items(id,tenant_id,supplier_id,warehouse_name,sku,name) VALUES($1,$2,$3,$4,$5,$6)',
    [itemId,tenant,kind==='supplier'?null:supplier,kind==='warehouse'?'Other warehouse':null,'OTHER','Other scope'])
  const before = await snap()
  await expect(applySupplierCatalogImported(tenant,operation())).rejects.toThrow()
  expect(await snap()).toEqual(before)
})
it('does not reassign the same import record to another supplier', async () => {
  await state.db.query('INSERT INTO supplier_price_imports(id,tenant_id,supplier_id,filename) VALUES($1,$2,NULL,$3)',[importId,tenant,'unassigned.csv'])
  const before = await snap()
  await expect(applySupplierCatalogImported(tenant,operation())).rejects.toThrow()
  expect(await snap()).toEqual(before)
})
it('rejects repeated item IDs across the 400-row batch boundary before changing the old price list', async () => {
  const op = operation()
  op.payload.items = Array.from({length:401},(_,index) => ({...row(),id:index===400?itemId: index===0?itemId:randomUUID(),sku:'SKU-'+index,name:'Name '+index}))
  const before = await snap()
  await expect(applySupplierCatalogImported(tenant,op)).rejects.toThrow(/ID|ідентифікатор/i)
  expect(await snap()).toEqual(before)
})
it('serializes deletion with the catalog writer and permits retry of an absent row', async () => {
  await applySupplierCatalogItemDeleted(tenant,{...metadata('supplier_catalog.item_deleted'),aggregate_id:itemId,created_at:at,payload:{id:itemId}})
  expect(state.queries[0]).toMatch(/pg_advisory_xact_lock/)
})
it('preserves valid replacement IDs and accepts an identical retry', async () => {
  const op = operation()
  await applySupplierCatalogImported(tenant,op)
  op.applied_at = '2026-10-07T07:00:00Z'
  await applySupplierCatalogImported(tenant,op)
  expect(await rows('SELECT id,price_kopecks FROM supplier_price_items WHERE supplier_id=$1 AND deleted_at IS NULL',[supplier])).toEqual([{id:itemId,price_kopecks:12000}])
  expect(await rows('SELECT id FROM supplier_price_imports')).toEqual([{id:importId}])
})
it('normalizes case when matching operation and payload UUIDs', async () => {
  const value = row()
  value.id = itemId.toUpperCase()
  await applySupplierCatalogItemUpsert(tenant,{...metadata('supplier_catalog.item_upserted'),aggregate_id:itemId,created_at:at,payload:value})
  expect(await rows('SELECT id FROM supplier_price_items WHERE id=$1',[itemId])).toEqual([{id:itemId}])
})

it.each(['supplier_price_items','supplier_price_imports'])('rolls back the entire replacement when %s silently skips a write', async table => {
  await state.db.query('INSERT INTO supplier_price_items(id,tenant_id,supplier_id,sku,name) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(),tenant,supplier,'PREVIOUS','Previous price list'])
  await state.db.exec(`CREATE OR REPLACE FUNCTION suppress_catalog_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER suppress_catalog_write BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION suppress_catalog_write();`)
  try {
    const before = await snap()
    await expect(applySupplierCatalogImported(tenant,operation())).rejects.toThrow(/Конфлікт/)
    expect(await snap()).toEqual(before)
  } finally {
    await state.db.exec('DROP TRIGGER suppress_catalog_write ON ' + table)
  }
})


it.each(['add', 'replace'])('persists %s import scope and original processed row count', async mode => {
  const op = operation()
  op.payload.mode = mode
  op.payload.warehouse_name = 'Main'
  op.payload.import.total_rows = op.payload.import.processed_rows = 401
  await applySupplierCatalogImported(tenant, op)
  expect(await rows('SELECT mode,warehouse_name,processed_rows FROM supplier_price_imports')).toEqual([{ mode, warehouse_name: 'Main', processed_rows: 401 }])
  expect(await rows('SELECT warehouse_name FROM supplier_price_items WHERE id=$1', [itemId])).toEqual([{ warehouse_name: 'Main' }])
  const before = await snap()
  await applySupplierCatalogImported(tenant, op)
  expect(await snap()).toEqual(before)
})

it.each([null, undefined, '', 'REPLACE', false, {}])('rejects invalid import mode %j before any writes', async mode => {
  const op = operation()
  op.payload.mode = mode
  const before = await snap()
  await expect(applySupplierCatalogImported(tenant, op)).rejects.toThrow(/режим/)
  expect(await snap()).toEqual(before)
})

it.each(['mode', 'warehouse'])('does not rewrite known import %s with a new operation ID', async field => {
  const first = operation()
  await applySupplierCatalogImported(tenant, first)
  const next = operation()
  if (field === 'mode') next.payload.mode = 'add'
  else next.payload.warehouse_name = 'Different'
  next.payload.items = [] // The header itself must protect its scope, even without item IDs.
  const before = await snap()
  await expect(applySupplierCatalogImported(tenant, next)).rejects.toThrow(/Конфлікт/)
  expect(await snap()).toEqual(before)
})

it('keeps legacy scope unknown until the original import operation supplies it', async () => {
  await state.db.query('INSERT INTO supplier_price_imports(id,tenant_id,supplier_id,filename) VALUES($1,$2,$3,$4)', [importId, tenant, supplier, 'legacy.csv'])
  expect(await rows('SELECT mode,warehouse_name FROM supplier_price_imports')).toEqual([{ mode: null, warehouse_name: null }])
  const op = operation()
  op.payload.warehouse_name = 'Main'
  await applySupplierCatalogImported(tenant, op)
  expect(await rows('SELECT mode,warehouse_name FROM supplier_price_imports')).toEqual([{ mode: 'replace', warehouse_name: 'Main' }])
})

it('rejects non-text warehouse metadata without replacing any rows', async () => {
  const op = operation()
  op.payload.warehouse_name = {}
  const before = await snap()
  await expect(applySupplierCatalogImported(tenant, op)).rejects.toThrow()
  expect(await snap()).toEqual(before)
})

it('migrates existing header rows without a fabricated mode and restricts future modes', async () => {
  const fixture = new PGlite()
  try {
    await fixture.exec("CREATE TABLE supplier_price_imports(id text PRIMARY KEY,filename text); INSERT INTO supplier_price_imports VALUES ('legacy','old.csv');")
    await fixture.exec(readFileSync(new URL('../../../../supabase/migrations/20261007173958_supplier_import_scope_metadata.sql',import.meta.url),'utf8'))
    expect((await fixture.query('SELECT * FROM supplier_price_imports')).rows).toEqual([{ id: 'legacy', filename: 'old.csv', mode: null, warehouse_name: null }])
    await expect(fixture.exec("UPDATE supplier_price_imports SET mode='wrong'")).rejects.toThrow()
    expect((await fixture.query('SELECT mode FROM supplier_price_imports')).rows).toEqual([{ mode: null }])
  } finally {
    await fixture.close()
  }
})

it('includes scope metadata in the common incremental and bootstrap catalog copy', () => {
  const source = readFileSync(new URL('../sync/pullService.ts', import.meta.url), 'utf8')
  const copy = readFileSync(new URL('../sync/supplierCatalogCopy.ts', import.meta.url), 'utf8')
  expect(source.match(/fetchSupplierCatalogCopy\(tenantId,/g)).toHaveLength(2)
  expect(copy).toContain('supplier_id,filename,mode,warehouse_name,status')
  expect(copy).toContain('FROM public.supplier_price_imports WHERE tenant_id=$1::uuid')
})

it.each([
  { qty: '2bad' }, { qty: '-1' }, { qty: '0.0001' }, { qty: true },
  { qty: '1 2' }, { price_kopecks: -1 }, { price_kopecks: 1.5 },
  { price_kopecks: null }, { price_kopecks: true },
])('rejects invalid catalog numbers %j without changing items, imports or receipts', async bad => {
  const op = operation()
  op.payload.items[0] = { ...op.payload.items[0], ...bad }
  const before = await snap()
  await expect(applySupplierCatalogImported(tenant, op)).rejects.toMatchObject({ status: 400 })
  expect(await snap()).toEqual(before)
})
it('keeps grouped quantities and comma thousandths without divergence from local data', async () => {
  await applySupplierCatalogItemUpsert(tenant, itemOperation({ ...row(), qty: '1 234,125' }))
  expect(await rows('SELECT qty FROM supplier_price_items WHERE id=$1', [itemId])).toEqual([{ qty: '1234.125' }])
})
it.each(['item', 'import'])('acknowledges an unchanged legacy %s receipt without reapplying old malformed numbers', async kind => {
  // The previous build accepted this payload. Only its durable receipt proves it ran.
  const old = kind === 'item' ? itemOperation({ ...row(), qty: '2bad' }) : operation()
  if (kind === 'import') old.payload.items[0].qty = '2bad'
  await state.db.transaction(async (tx: any) => {
    const client: any = { query: async (sql: string, args: any[]) => tx.query(sql, args) }
    const receipt = await lockCatalogCopy(client, tenant, old, old.operation_type)
    await saveCatalogReceipt(client, receipt!, [])
  })
  const before = await snap()
  const apply = kind === 'item' ? applySupplierCatalogItemUpsert : applySupplierCatalogImported
  await apply(tenant, old)
  expect(await snap()).toEqual(before)
  const changed = structuredClone(old)
  if (kind === 'item') changed.payload.qty = '3'
  else changed.payload.items[0].qty = '3'
  await expect(apply(tenant, changed)).rejects.toMatchObject({ status: 409 })
  expect(await snap()).toEqual(before)
})
it.each(['item', 'import'])('does not poison the %s receipt after invalid numbers and permits corrected retry', async kind => {
  const op = kind === 'item' ? itemOperation({ ...row(), qty: '0.0001' }) : operation()
  if (kind === 'import') op.payload.items[0].qty = '0.0001'
  const apply = kind === 'item' ? applySupplierCatalogItemUpsert : applySupplierCatalogImported
  const before = await snap()
  await expect(apply(tenant, op)).rejects.toMatchObject({ status: 400 })
  expect(await snap()).toEqual(before)
  if (kind === 'item') op.payload.qty = '0,125'
  else op.payload.items[0].qty = '0,125'
  await apply(tenant, op)
  expect(await rows('SELECT qty FROM supplier_price_items WHERE id=$1', [itemId])).toEqual([{ qty: '0.125' }])
  const after = await snap()
  await apply(tenant, op)
  expect(await snap()).toEqual(after)
})
const tenant=randomUUID(), supplier=randomUUID(), itemId=randomUUID(), importId=randomUUID(), at='2026-10-07T06:00:00Z'
const row = () => ({ id:itemId, supplier_id:supplier, sku:'TEST', name:'Test product', price_kopecks:12000, qty:'2' })
let sequence = 0
const metadata = (type: string) => ({ operation_id:randomUUID(),tenant_id:tenant,device_id:'catalog-main',sequence:++sequence,operation_type:type,created_at:at })
const operation = ():any => ({ ...metadata('supplier_catalog.imported'), aggregate_id:importId, payload:{ import:{id:importId,supplier_id:supplier,filename:'test.csv'}, mode:'replace',items:[row()] } })
const itemOperation = (payload:any = row()):any => ({...metadata('supplier_catalog.item_upserted'),aggregate_id:payload.id,payload})
const deleteOperation = (id=itemId):any => ({...metadata('supplier_catalog.item_deleted'),aggregate_id:id,payload:{id}})
const rows = async (sql:string,args:any[]=[]) => (await state.db.query(sql,args)).rows
const snap = async () => [await rows('SELECT * FROM supplier_price_items ORDER BY id'),await rows('SELECT * FROM supplier_price_imports ORDER BY id'),await rows('SELECT * FROM suppliers ORDER BY id'),await rows('SELECT * FROM supplier_catalog_copy_receipts ORDER BY operation_id')]
beforeAll(async()=>{
  state.db=new PGlite()
  await state.db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;')
  await state.db.exec(readFileSync(new URL('../../../../supabase/migrations/20261007163229_supplier_catalog_copy_receipts.sql',import.meta.url),'utf8'))
  await state.db.exec(`
    CREATE TABLE suppliers(id uuid PRIMARY KEY,tenant_id uuid,name text,is_active boolean DEFAULT true,deleted_at timestamptz);
    CREATE TABLE supplier_price_items(id uuid PRIMARY KEY,tenant_id uuid,supplier_id uuid REFERENCES suppliers,sku text,barcode text,brand text,name text,price_kopecks int,qty text,warehouse_name text,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz);
    CREATE TABLE supplier_price_imports(id uuid PRIMARY KEY,tenant_id uuid,supplier_id uuid REFERENCES suppliers,filename text,status text,total_rows int,processed_rows int,errors_log jsonb,created_at timestamptz,updated_at timestamptz);
  `)
})
beforeAll(async()=>{
  await state.db.exec(readFileSync(new URL('../../../../supabase/migrations/20261007173958_supplier_import_scope_metadata.sql',import.meta.url),'utf8'))
})
afterAll(async()=>state.db.close())
beforeEach(async()=>{
  await state.db.exec('TRUNCATE supplier_catalog_copy_receipts,supplier_price_imports,supplier_price_items,suppliers CASCADE')
  await state.db.query('INSERT INTO suppliers(id,tenant_id,name) VALUES($1,$2,$3)',[supplier,tenant,'Supplier'])
  await state.db.query('INSERT INTO supplier_price_items(id,tenant_id,sku,name) VALUES($1,$2,$3,$4)',[randomUUID(),tenant,'UNASSIGNED','Unassigned product'])
  state.queries=[]
  sequence=0
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
  await expect(applySupplierCatalogItemUpsert(tenant,{...metadata('supplier_catalog.item_upserted'),aggregate_id:itemId,created_at:at,payload:{...row(),supplier_id:'broken'}})).rejects.toThrow(/постачальник/i)
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

it.each(['edit','delete','replacement'])('does not replay an old replace import over a newer %s', async kind => {
  const old = operation()
  await applySupplierCatalogImported(tenant,old)
  if (kind==='edit') await applySupplierCatalogItemUpsert(tenant,itemOperation({...row(),price_kopecks:17500}))
  if (kind==='delete') await applySupplierCatalogItemDeleted(tenant,deleteOperation())
  if (kind==='replacement') {
    const next=operation()
    next.aggregate_id=next.payload.import.id=randomUUID()
    next.payload.items=[{...row(),id:randomUUID(),sku:'NEW',name:'New price'}]
    await applySupplierCatalogImported(tenant,next)
  }
  const before=await snap()
  await applySupplierCatalogImported(tenant,{...old,applied_at:'2026-10-08T12:00:00Z'})
  expect(await snap()).toEqual(before)
})

it('rejects changed contents under the same operation ID', async () => {
  const op=operation()
  await applySupplierCatalogImported(tenant,op)
  const before=await snap()
  op.payload.items[0].price_kopecks=1
  await expect(applySupplierCatalogImported(tenant,op)).rejects.toThrow()
  expect(await snap()).toEqual(before)
})

it('acknowledges the original item edit without reverting a later edit',async()=>{
  const old=itemOperation()
  await applySupplierCatalogItemUpsert(tenant,old)
  await applySupplierCatalogItemUpsert(tenant,itemOperation({...row(),price_kopecks:19000}))
  const before=await snap()
  await applySupplierCatalogItemUpsert(tenant,old)
  expect(await snap()).toEqual(before)
})
it('does not repeat an old deletion after a newer intentional recreation',async()=>{
  await applySupplierCatalogItemUpsert(tenant,itemOperation())
  const old=deleteOperation()
  await applySupplierCatalogItemDeleted(tenant,old)
  await applySupplierCatalogItemUpsert(tenant,itemOperation({...row(),price_kopecks:19000}))
  const before=await snap()
  await applySupplierCatalogItemDeleted(tenant,old)
  expect(await snap()).toEqual(before)
})
it.each(['inactive','deleted'])('acknowledges a committed import after the supplier becomes %s without writing again',async kind=>{
  const old=operation()
  await applySupplierCatalogImported(tenant,old)
  await state.db.query(kind==='inactive'?'UPDATE suppliers SET is_active=false':'UPDATE suppliers SET deleted_at=now()')
  const before=await snap()
  await applySupplierCatalogImported(tenant,old)
  expect(await snap()).toEqual(before)
})
it.each(['device_id','sequence','aggregate_id','operation_type'])('rejects a forged %s under an acknowledged operation ID',async field=>{
  const old=operation()
  await applySupplierCatalogImported(tenant,old)
  const before=await snap()
  const next={...old,[field]:field==='sequence'?99:field==='operation_type'?'supplier_catalog.item_upserted':randomUUID()}
  if(field==='aggregate_id') next.payload={...old.payload,import:{...old.payload.import,id:next.aggregate_id}}
  await expect(applySupplierCatalogImported(tenant,next)).rejects.toThrow()
  expect(await snap()).toEqual(before)
})
it.each([
  ['tenant_id',randomUUID()],['operation_id','bad'],['device_id','  '],
  ['sequence',0],['sequence',1.5],['sequence',Number.MAX_SAFE_INTEGER+1],['operation_type','other'],
])('rejects invalid operation metadata %s=%s before any price mutation',async(field,value)=>{
  const before=await snap()
  await expect(applySupplierCatalogImported(tenant,{...operation(),[field]:value})).rejects.toThrow()
  expect(await snap()).toEqual(before)
})
it('does not depend on payload property order or the changing server apply time for exact retries',async()=>{
  const old=operation()
  await applySupplierCatalogImported(tenant,old)
  const before=await snap()
  const reorder=(value:any):any=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reorder(v)])):value
  await applySupplierCatalogImported(tenant,{...old,created_at:'2030-01-01T00:00:00Z',applied_at:'2030-01-01T00:00:00Z',payload:reorder(old.payload)})
  expect(await snap()).toEqual(before)
})
it('does not accept a different payload just because an operation ID exists in another tenant',async()=>{
  const old=operation()
  await applySupplierCatalogImported(tenant,old)
  const foreign=operation()
  foreign.tenant_id=randomUUID()
  foreign.operation_id=old.operation_id
  foreign.aggregate_id=foreign.payload.import.id=randomUUID()
  foreign.payload.import.supplier_id=null
  foreign.payload.items=[{...row(),id:randomUUID()}]
  await applySupplierCatalogImported(foreign.tenant_id,foreign)
  expect(await rows('SELECT tenant_id FROM supplier_catalog_copy_receipts WHERE operation_id=$1',[old.operation_id])).toHaveLength(2)
})
it.each(['import','item','delete'])('rejects an unseen old %s after a newer operation on the same list',async kind=>{
  const old=kind==='import'?operation():kind==='item'?itemOperation():deleteOperation()
  await applySupplierCatalogItemUpsert(tenant,itemOperation({...row(),price_kopecks:19000}))
  const before=await snap()
  const apply=kind==='import'?applySupplierCatalogImported:kind==='item'?applySupplierCatalogItemUpsert:applySupplierCatalogItemDeleted
  await expect(apply(tenant,old)).rejects.toMatchObject({status:409})
  expect(await snap()).toEqual(before)
})
it('allows a delayed unrelated supplier copy rather than using a device-wide high-water mark',async()=>{
  const old=operation()
  const other=randomUUID()
  await state.db.query('INSERT INTO suppliers(id,tenant_id,name) VALUES($1,$2,$3)',[other,tenant,'Other'])
  await applySupplierCatalogItemUpsert(tenant,itemOperation({...row(),id:randomUUID(),supplier_id:other}))
  await applySupplierCatalogImported(tenant,old)
  expect(await rows('SELECT * FROM supplier_catalog_copy_receipts')).toHaveLength(2)
})
it('allows a delayed unrelated warehouse copy',async()=>{
  const old=operation()
  await applySupplierCatalogItemUpsert(tenant,itemOperation({...row(),id:randomUUID(),warehouse_name:'Branch'}))
  await applySupplierCatalogImported(tenant,old)
  expect(await rows('SELECT * FROM supplier_catalog_copy_receipts')).toHaveLength(2)
})
it('blocks reuse of an already committed source sequence even for another scope',async()=>{
  await applySupplierCatalogImported(tenant,operation())
  const next=itemOperation({...row(),id:randomUUID(),warehouse_name:'Branch'})
  next.sequence=1
  const before=await snap()
  await expect(applySupplierCatalogItemUpsert(tenant,next)).rejects.toMatchObject({status:409})
  expect(await snap()).toEqual(before)
})
it('retains both old and new scopes when moving an item so an older copy cannot rewrite either list',async()=>{
  await applySupplierCatalogItemUpsert(tenant,itemOperation())
  const old=operation()
  await applySupplierCatalogItemUpsert(tenant,itemOperation({...row(),warehouse_name:'Moved'}))
  const before=await snap()
  await expect(applySupplierCatalogImported(tenant,old)).rejects.toMatchObject({status:409})
  expect(await snap()).toEqual(before)
  expect((await rows('SELECT scope_keys FROM supplier_catalog_copy_receipts ORDER BY source_sequence DESC LIMIT 1'))[0].scope_keys).toHaveLength(2)
})
it.each(['item','import'])('records deletion of an absent row and rejects an earlier unseen %s creating it',async kind=>{
  const old=kind==='import'?operation():itemOperation()
  await applySupplierCatalogItemDeleted(tenant,deleteOperation())
  const before=await snap()
  await expect((kind==='import'?applySupplierCatalogImported:applySupplierCatalogItemUpsert)(tenant,old)).rejects.toMatchObject({status:409})
  expect(await snap()).toEqual(before)
})
it.each(['import','item','delete'])('rolls back all %s changes when acknowledgement is silently skipped',async kind=>{
  await applySupplierCatalogItemUpsert(tenant,itemOperation())
  await state.db.exec(`CREATE OR REPLACE FUNCTION suppress_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER suppress_receipt BEFORE INSERT ON supplier_catalog_copy_receipts FOR EACH ROW EXECUTE FUNCTION suppress_receipt();`)
  try {
    const before=await snap()
    const op=kind==='import'?operation():kind==='item'?itemOperation({...row(),price_kopecks:1}):deleteOperation()
    const apply=kind==='import'?applySupplierCatalogImported:kind==='item'?applySupplierCatalogItemUpsert:applySupplierCatalogItemDeleted
    await expect(apply(tenant,op)).rejects.toMatchObject({status:409})
    expect(await snap()).toEqual(before)
  }finally{await state.db.exec('DROP TRIGGER suppress_receipt ON supplier_catalog_copy_receipts')}
})
it.each(['replace','delete'])('does not acknowledge a %s when a trigger silently prevents removal',async kind=>{
  await applySupplierCatalogItemUpsert(tenant,itemOperation())
  await state.db.exec(`CREATE OR REPLACE FUNCTION suppress_removal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER suppress_removal BEFORE UPDATE ON supplier_price_items FOR EACH ROW EXECUTE FUNCTION suppress_removal();`)
  try {
    const before=await snap()
    const op=kind==='replace'?operation():deleteOperation()
    if(kind==='replace') op.payload.items=[]
    await expect((kind==='replace'?applySupplierCatalogImported:applySupplierCatalogItemDeleted)(tenant,op)).rejects.toMatchObject({status:409})
    expect(await snap()).toEqual(before)
  }finally{await state.db.exec('DROP TRIGGER suppress_removal ON supplier_price_items')}
})
it('can retry the exact operation after a failed transaction; a failed receipt does not poison the queue',async()=>{
  const old=operation()
  await state.db.exec(`CREATE OR REPLACE FUNCTION fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected failure'; END $$;
    CREATE TRIGGER fail_receipt BEFORE INSERT ON supplier_catalog_copy_receipts FOR EACH ROW EXECUTE FUNCTION fail_receipt();`)
  const before=await snap()
  try {await expect(applySupplierCatalogImported(tenant,old)).rejects.toThrow('Injected failure')}
  finally {await state.db.exec('DROP TRIGGER fail_receipt ON supplier_catalog_copy_receipts')}
  expect(await snap()).toEqual(before)
  await applySupplierCatalogImported(tenant,old)
  expect(await rows('SELECT * FROM supplier_catalog_copy_receipts')).toHaveLength(1)
})
it('persists receipts across a database export/restart, not just an in-memory cache',async()=>{
  const old=operation()
  await applySupplierCatalogImported(tenant,old)
  await applySupplierCatalogItemUpsert(tenant,itemOperation({...row(),price_kopecks:19000}))
  const dump=await state.db.dumpDataDir()
  await state.db.close()
  state.db=await PGlite.create({loadDataDir:dump})
  const before=await snap()
  await applySupplierCatalogImported(tenant,old)
  expect(await snap()).toEqual(before)
})
it.each(['anon','authenticated'])('denies %s access to receipt contents and writes',async role=>{
  await applySupplierCatalogImported(tenant,operation())
  for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) {
    expect((await rows("SELECT has_table_privilege($1,'supplier_catalog_copy_receipts',$2) AS allowed",[role,privilege]))[0].allowed).toBe(false)
  }
  await state.db.exec('SET ROLE '+role)
  try {await expect(rows('SELECT * FROM supplier_catalog_copy_receipts')).rejects.toMatchObject({code:'42501'})}
  finally {await state.db.exec('RESET ROLE')}
})
it('enables RLS and grants the internal role only append/read, not receipt rewriting',async()=>{
  expect((await rows("SELECT relrowsecurity FROM pg_class WHERE oid='supplier_catalog_copy_receipts'::regclass"))[0].relrowsecurity).toBe(true)
  for(const [privilege,expected] of [['SELECT',true],['INSERT',true],['UPDATE',false],['DELETE',false],['TRUNCATE',false]]) {
    expect((await rows("SELECT has_table_privilege('service_role','supplier_catalog_copy_receipts',$1) AS allowed",[privilege]))[0].allowed).toBe(expected)
  }
})
it('keeps tenant-scoped receipt cleanup before catalog data in the explicit full reset',()=>{
  const code=readFileSync(new URL('../adminService.ts',import.meta.url),'utf8')
  const receipt=code.indexOf('DELETE FROM supplier_catalog_copy_receipts WHERE tenant_id = $1')
  expect(receipt).toBeGreaterThan(0)
  expect(receipt).toBeLessThan(code.indexOf('DELETE FROM supplier_price_items WHERE tenant_id = $1'))
})
it('enforces immutable operation and source sequence identities in the database',async()=>{
  await applySupplierCatalogImported(tenant,operation())
  await expect(state.db.query(`INSERT INTO supplier_catalog_copy_receipts
    SELECT tenant_id,$1,aggregate_id,operation_type,device_id,source_sequence,payload_hash,scope_keys,recorded_at
    FROM supplier_catalog_copy_receipts`,[randomUUID()])).rejects.toMatchObject({code:'23505'})
  await expect(state.db.query(`INSERT INTO supplier_catalog_copy_receipts
    SELECT tenant_id,operation_id,aggregate_id,operation_type,device_id,source_sequence+1,payload_hash,scope_keys,recorded_at
    FROM supplier_catalog_copy_receipts`)).rejects.toMatchObject({code:'23505'})
})
