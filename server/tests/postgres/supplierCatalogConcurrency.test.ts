import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({ nextHook: null as null | ((sql: string) => Promise<void>) }))
vi.mock('../../src/db/pg.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/pg.js')>()
  return { ...actual, runTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => {
    const hook = control.nextHook
    control.nextHook = null
    // Keep the real pool, BEGIN/COMMIT/ROLLBACK and separate PostgreSQL sessions.
    return actual.runTransaction(client => fn(new Proxy(client, { get(target,key) {
      if (key !== 'query') return Reflect.get(target,key)
      return async (sql: string, args?: unknown[]) => {
        const result = await target.query(sql,args)
        await hook?.(sql)
        return result
      }
    } })))
  } }
})
// These tests must never reach cloud RPC or change product stock.
vi.mock('../../src/db/supabase.js', () => ({ db: new Proxy({}, {
  get() { throw Error('Cloud/stock access is forbidden in PostgreSQL concurrency fixtures') },
}) }))
import { pool } from '../../src/db/pg.js'
import { applySupplierCatalogItemUpsert, applySupplierCatalogItemDeleted, applySupplierCatalogImported } from '../../src/services/supplierCatalogSyncService.js'
import { applySupplierHistoryMerged } from '../../src/services/sync/supplierHistoryMerge.js'
import { applySupplierInvoiceCreated } from '../../src/services/sync/supplierInvoiceMirror.js'
import { applySupplierInvoicePaymentAdded } from '../../src/services/sync/supplierPaymentMirror.js'
import { mergeEmptySupplier } from '../../src/services/supplierMergeSafety.js'

const at = '2026-10-01T10:00:00.000Z'
let tenant: string, source: string, target: string, actor: string, shift: string
const rows = async (sql: string, args: unknown[] = []) => (await pool.query(sql,args)).rows
const put = (op: any) => applySupplierCatalogItemUpsert(op.tenant_id,op)
const merge = (op: any) => applySupplierHistoryMerged(op.tenant_id,op)

beforeAll(async () => {
  const identity = (await rows("SELECT current_database() AS db,current_setting('application_name') AS app"))[0]
  if (!/^forsage_concurrency_test(?:_[a-z0-9_]+)?$/.test(identity.db)
    || identity.app !== 'forsage-concurrency-test') throw Error('Unsafe PostgreSQL fixture target')
  if ((await rows("SELECT 1 FROM information_schema.tables WHERE table_schema='public'")).length) {
    throw Error('Fixture requires an EMPTY isolated database; existing tables are never replaced')
  }
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
    END $$;
    CREATE TABLE suppliers(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,deleted_at timestamptz,is_active boolean DEFAULT true,updated_at timestamptz);
    CREATE TABLE supplier_price_items(id uuid PRIMARY KEY,tenant_id uuid,supplier_id uuid REFERENCES suppliers,sku text,barcode text,brand text,name text,price_kopecks int,qty text,warehouse_name text,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz);
    CREATE TABLE supplier_price_imports(id uuid PRIMARY KEY,tenant_id uuid,supplier_id uuid REFERENCES suppliers,filename text,mode text,warehouse_name text,status text,total_rows int,processed_rows int,errors_log jsonb,created_at timestamptz,updated_at timestamptz);
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_app_meta_data jsonb);
    CREATE TABLE sync_deletions(tenant_id uuid,entity_type text,entity_id uuid);
    CREATE TABLE shifts(id uuid PRIMARY KEY,tenant_id uuid,status text,opening_cash int);
    CREATE TABLE supply_invoices(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,supplier_id uuid REFERENCES suppliers,invoice_number varchar(100),status text,total int NOT NULL,paid_amount int,payment_method text,notes text,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz,posted_by uuid,posted_at timestamptz,draft_payload jsonb,draft_saved_at timestamptz,draft_saved_by uuid);
    CREATE TABLE supply_invoice_items(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,invoice_id uuid NOT NULL REFERENCES supply_invoices,product_id uuid NOT NULL,qty numeric(12,3) NOT NULL,purchase_price int NOT NULL,total int NOT NULL,created_at timestamptz NOT NULL,deleted_at timestamptz);
    CREATE TABLE supplier_payments(id uuid PRIMARY KEY,tenant_id uuid,invoice_id uuid REFERENCES supply_invoices,supplier_id uuid REFERENCES suppliers,amount int NOT NULL,payment_method text,fund_source text,shift_id uuid REFERENCES shifts,note text,created_by uuid NOT NULL,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz);
    CREATE TABLE cash_operations(id uuid PRIMARY KEY,tenant_id uuid,shift_id uuid,type text,amount int,note text,source text,created_by uuid,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz,sale_id uuid,employee_id uuid,work_date date);
    CREATE TABLE products(id uuid PRIMARY KEY,tenant_id uuid,qty_on_hand numeric,purchase_price int);
  `)
  for (const name of [
    '20261005170920_supplier_invoice_copy_receipts.sql',
    '20261007163229_supplier_catalog_copy_receipts.sql',
    '20261010185339_supplier_catalog_ownership_proof.sql',
    '20261006081852_supplier_empty_merge_receipts.sql',
    '20261006060854_supplier_invoice_terminal_receipts.sql',
    '20261006091417_supplier_history_merge_receipts.sql',
  ]) await pool.query(readFileSync(new URL('../../../supabase/migrations/' + name,import.meta.url),'utf8'))
})
afterAll(async () => { await pool.end() })
beforeEach(async () => {
  control.nextHook = null
  // Only fixture tables created above. No schema reset, production credentials or remote URL.
  await pool.query('TRUNCATE supplier_catalog_copy_receipts,supplier_merge_receipts,supplier_invoice_copy_receipts,supplier_price_items,supplier_price_imports,supplier_payments,supply_invoice_items,supply_invoices,suppliers,products,shifts,auth.users,cash_operations,sync_deletions')
  tenant=randomUUID();source=randomUUID();target=randomUUID();actor=randomUUID();shift=randomUUID()
  await pool.query("INSERT INTO auth.users VALUES($1,jsonb_build_object('tenant_id',$2::text))",[actor,tenant])
  await pool.query("INSERT INTO shifts VALUES($1,$2,'closed',0)",[shift,tenant])
  await pool.query('INSERT INTO suppliers(id,tenant_id) VALUES($1,$3),($2,$3)',[source,target,tenant])
  await pool.query('INSERT INTO products VALUES($1,$2,17,12345)',[randomUUID(),tenant])
})
function upsert(owner=source, sequence=10, overrides: any = {}): any {
  const row={id:randomUUID(),supplier_id:owner,sku:'SKU-'+randomUUID(),barcode:null,brand:'TEST',
    name:'Fixture '+randomUUID(),price_kopecks:12345,qty:'0.125',warehouse_name:'Main',created_at:at,...overrides}
  return {tenant_id:tenant,device_id:'primary',operation_id:randomUUID(),sequence,aggregate_id:row.id,
    operation_type:'supplier_catalog.item_upserted',created_at:at,applied_at:at,payload:row}
}
function edit(op: any, sequence: number, data: any = {}): any {
  return {...op,operation_id:randomUUID(),sequence,payload:{...op.payload,...data}}
}
function imported(owner=source, sequence=20, items: any[]=[]): any {
  const id=randomUUID()
  return {...upsert(owner,sequence),aggregate_id:id,operation_type:'supplier_catalog.imported',
    payload:{mode:'replace',warehouse_name:'Main',created_at:at,
      import:{id,supplier_id:owner,filename:'fixture.csv',created_at:at},items}}
}
async function manifest(): Promise<any> {
  const items=await rows('SELECT * FROM supplier_price_items WHERE supplier_id=$1 ORDER BY id',[source])
  return {tenant_id:tenant,device_id:'primary',operation_id:randomUUID(),sequence:100,
    aggregate_id:target,aggregate_type:'supplier',operation_type:'supplier.merged',created_at:at,
    payload:{history_version:1,primary_supplier_id:target,duplicate_supplier_id:source,invoices:[],
      catalog:{version:1,imports:[],items:items.map(r=>({id:r.id,sku:r.sku,barcode:r.barcode,brand:r.brand,
        name:r.name,price_kopecks:r.price_kopecks,qty:r.qty,warehouse_name:r.warehouse_name,
        created_at:r.created_at.toISOString(),deleted_at:r.deleted_at?.toISOString()??null}))}}}
}
function deferred() { let resolve!:()=>void; const promise=new Promise<void>(r=>{resolve=r}); return {promise,resolve} }
type Outcome = {ok:true} | {ok:false; error:any}
function outcome(fn:()=>Promise<unknown>):Promise<Outcome> {
  return fn().then(()=>({ok:true as const}),error=>({ok:false as const,error}))
}
function holdNext(match: string) {
  const entered=deferred(),released=deferred()
  let held=false
  control.nextHook=async sql=>{
    if (!held && sql.includes(match)) {held=true;entered.resolve();await released.promise}
  }
  return {entered:entered.promise,release:released.resolve}
}
async function bounded(promise: Promise<unknown>, message:string) {
  let timer:ReturnType<typeof setTimeout>|undefined
  try { await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),4000)})]) }
  finally {clearTimeout(timer)}
}
async function blocked() {
  const deadline=Date.now()+4000
  while(Date.now()<deadline) {
    const waiting=await rows(`SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE datname=current_database() AND application_name='forsage-concurrency-test'
        AND wait_event_type='Lock' AND pid<>pg_backend_pid()`)
    if(waiting.some(row=>row.blockers.length)) return
    await new Promise(resolve=>setTimeout(resolve,20))
  }
  throw Error('Second session did not demonstrably wait on a PostgreSQL lock')
}
async function pair(first:()=>Promise<unknown>,second:()=>Promise<unknown>,pause='INSERT INTO supplier_catalog_copy_receipts') {
  const gate=holdNext(pause),a=outcome(first)
  let b:Promise<Outcome>|undefined
  let barrierError:unknown
  try {
    await bounded(gate.entered,'First transaction did not reach the commit barrier')
    b=outcome(second)
    await blocked()
  } catch(error) {barrierError=error} finally {gate.release()}
  const results=await Promise.all([a,b??Promise.resolve({ok:false,error:Error('Second operation not started')} as Outcome)])
  if(barrierError)throw barrierError
  return results
}
const ok=(result:Outcome)=>expect(result).toEqual({ok:true})
const rejected=(result:Outcome,code?:string)=>{expect(result.ok).toBe(false);if(!result.ok){expect(result.error.code).not.toBe('40P01');if(code)expect(result.error.code).toBe(code)}}
const snapshot=()=>rows('SELECT * FROM supplier_price_items ORDER BY id')
const unchangedStock=async()=>expect(await rows('SELECT qty_on_hand::text AS qty,purchase_price FROM products')).toEqual([{qty:'17',purchase_price:12345}])

it('uses separate sessions and commits concurrent identical delivery exactly once',async()=>{
  const op=upsert();const [a,b]=await pair(()=>put(op),()=>put(op));ok(a);ok(b)
  expect(await rows('SELECT count(*)::int AS n FROM supplier_catalog_copy_receipts')).toEqual([{n:1}])
  expect(await snapshot()).toHaveLength(1);await unchangedStock()
})
it('blocks an old unseen copy behind a newer committed edit without restoring price',async()=>{
  const op=upsert();await put(op)
  const [a,b]=await pair(()=>put(edit(op,30,{price_kopecks:99999})),()=>put(edit(op,20,{price_kopecks:1})))
  ok(a);rejected(b,'SYNC_SUPPLIER_CATALOG_CONFLICT')
  expect((await snapshot())[0].price_kopecks).toBe(99999);await unchangedStock()
})
it('allows increasing source order after waiting for the previous commit',async()=>{
  const op=upsert();await put(op)
  const [a,b]=await pair(()=>put(edit(op,20,{price_kopecks:555})),()=>put(edit(op,30,{price_kopecks:777})))
  ok(a);ok(b);expect((await snapshot())[0].price_kopecks).toBe(777)
})
it('acknowledges an old known retry after an edit without overwriting it',async()=>{
  const op=upsert();await put(op)
  const [a,b]=await pair(()=>put(edit(op,20,{qty:'7.5'})),()=>put(op))
  ok(a);ok(b);expect((await snapshot())[0].qty).toBe('7.5')
})
it('does not create duplicate SKU rows when two distinct IDs arrive together',async()=>{
  const a=upsert(),b=upsert(source,20,{sku:a.payload.sku})
  const result=await pair(()=>put(a),()=>put(b));ok(result[0]);rejected(result[1],'SYNC_SUPPLIER_CATALOG_DUPLICATE')
  expect(await snapshot()).toHaveLength(1)
})
it('rejects a same-sequence different operation after the first commit',async()=>{
  const a=upsert(),b=upsert(source,a.sequence)
  const result=await pair(()=>put(a),()=>put(b));ok(result[0]);rejected(result[1],'SYNC_SUPPLIER_CATALOG_CONFLICT')
  expect(await snapshot()).toHaveLength(1)
})
it('rolls back a failed writer and releases its lock for the waiting legitimate retry',async()=>{
  const op=upsert(),gate=holdNext('INSERT INTO supplier_catalog_copy_receipts')
  const original=control.nextHook!
  control.nextHook=async sql=>{await original(sql);if(sql.includes('INSERT INTO supplier_catalog_copy_receipts'))throw Error('injected rollback')}
  const a=outcome(()=>put(op));let b:Promise<Outcome>|undefined
  try {await bounded(gate.entered,'rollback barrier');b=outcome(()=>put(op));await blocked()}finally{gate.release()}
  rejected(await a);ok(await b!)
  expect(await rows('SELECT count(*)::int AS n FROM supplier_catalog_copy_receipts')).toEqual([{n:1}])
})
it('rejects a changed manifest after a concurrent catalog edit commits',async()=>{
  const op=upsert();await put(op);const m=await manifest()
  const result=await pair(()=>put(edit(op,20,{price_kopecks:999})),()=>merge(m))
  ok(result[0]);rejected(result[1],'SYNC_SUPPLIER_CATALOG_CONFLICT')
  expect((await snapshot())[0].supplier_id).toBe(source)
  expect(await rows('SELECT * FROM supplier_merge_receipts')).toHaveLength(0)
})
it('lets merge commit before a later explicit owner change and validates the old retry',async()=>{
  const op=upsert();await put(op);const m=await manifest()
  const moved=edit(op,110,{supplier_id:null,price_kopecks:999})
  const result=await pair(()=>merge(m),()=>put(moved),'INSERT INTO supplier_merge_receipts')
  ok(result[0]);ok(result[1]);const before=await snapshot();await merge(m);expect(await snapshot()).toEqual(before)
  expect(before[0].supplier_id).toBeNull();await unchangedStock()
})
it('serializes two copies of the same catalog merge without duplicate receipts',async()=>{
  await put(upsert());const m=await manifest()
  const result=await pair(()=>merge(m),()=>merge(m),'INSERT INTO supplier_merge_receipts');result.forEach(ok)
  expect(await rows('SELECT count(*)::int AS n FROM supplier_merge_receipts')).toEqual([{n:1}])
})
it('rejects a stale replacement after merge instead of deleting transferred rows',async()=>{
  await put(upsert());const m=await manifest(),replacement=imported(target,90)
  const result=await pair(()=>merge(m),()=>applySupplierCatalogImported(tenant,replacement),'INSERT INTO supplier_merge_receipts')
  ok(result[0]);rejected(result[1],'SYNC_SUPPLIER_CATALOG_CONFLICT')
  expect((await snapshot())[0].deleted_at).toBeNull();await unchangedStock()
})
it('waits for item deletion before rejecting a now-stale merge snapshot',async()=>{
  const op=upsert();await put(op);const m=await manifest()
  const deletion={...edit(op,20),operation_type:'supplier_catalog.item_deleted',payload:{id:op.aggregate_id,created_at:at}}
  const result=await pair(()=>applySupplierCatalogItemDeleted(tenant,deletion),()=>merge(m))
  ok(result[0]);rejected(result[1],'SYNC_SUPPLIER_CATALOG_CONFLICT');expect((await snapshot())[0].deleted_at).not.toBeNull()
})
it('does not archive a supplier after a waiting catalog insert establishes a reference',async()=>{
  const result=await pair(()=>put(upsert()),()=>mergeEmptySupplier(target,source,tenant,at))
  ok(result[0]);rejected(result[1],'SUPPLIER_MERGE_HISTORY')
  expect((await rows('SELECT deleted_at FROM suppliers WHERE id=$1',[source]))[0].deleted_at).toBeNull()
})
it('does not insert a catalog reference after an empty supplier merge commits',async()=>{
  const result=await pair(()=>mergeEmptySupplier(target,source,tenant,at),()=>put(upsert()),'INSERT INTO supplier_merge_receipts')
  ok(result[0]);rejected(result[1],'SUPPLIER_NOT_FOUND');expect(await snapshot()).toHaveLength(0)
})
it('opposite-direction empty merges use consistent locks rather than deadlocking',async()=>{
  const result=await pair(()=>mergeEmptySupplier(target,source,tenant,at),()=>mergeEmptySupplier(source,target,tenant,at),'INSERT INTO supplier_merge_receipts')
  ok(result[0]);rejected(result[1],'SUPPLIER_MERGE_CONFLICT')
})
it('allows an unrelated tenant to commit while this tenant holds its catalog lock',async()=>{
  const other=randomUUID(),owner=randomUUID()
  await pool.query('INSERT INTO suppliers(id,tenant_id) VALUES($1,$2)',[owner,other])
  const a=upsert(),b={...upsert(owner,10),tenant_id:other},gate=holdNext('INSERT INTO supplier_catalog_copy_receipts')
  const pending=outcome(()=>put(a))
  try {await bounded(gate.entered,'tenant barrier');await bounded(put(b),'Unrelated tenant was blocked')}
  finally{gate.release()}
  ok(await pending);expect(await snapshot()).toHaveLength(2)
})

async function invoice(paid=0):Promise<any> {
  const product=(await rows('SELECT id FROM products'))[0].id,id=randomUUID()
  return {tenant_id:tenant,device_id:'primary',operation_id:randomUUID(),sequence:50,
    aggregate_id:id,aggregate_type:'supply_invoice',operation_type:'supplier_invoice.created',created_at:at,applied_at:at,
    payload:{id,supplier_id:source,invoice_number:'CONCURRENCY',notes:'Synthetic fixture',total:200,paid_amount:paid,
      payment_id:paid?randomUUID():null,payment_method:paid?'cash':null,fund_source:paid?'cashbox':'bank_account',
      shift_id:paid?shift:null,user_id:actor,created_at:at,
      items:[{id:randomUUID(),product_id:product,qty:2,purchase_price:100,total:200,created_at:at}]}}
}
const createInvoice=(op:any)=>applySupplierInvoiceCreated(tenant,actor,op)
const payInvoice=(op:any)=>applySupplierInvoicePaymentAdded(tenant,actor,op)
function payment(op:any,owner=source):any {
  return {...op,operation_id:randomUUID(),sequence:110,operation_type:'supplier_invoice.payment_added',
    payload:{id:op.aggregate_id,payment_id:randomUUID(),supplier_id:owner,amount:75,payment_method:'cash',
      fund_source:'cashbox',shift_id:shift,note:'Synthetic payment',user_id:actor,created_at:at}}
}
async function attachInvoice(m:any,op:any) {
  const r=(await rows('SELECT * FROM supply_invoices WHERE id=$1',[op.aggregate_id]))[0]
  const payments=await rows('SELECT * FROM supplier_payments WHERE invoice_id=$1 ORDER BY id',[op.aggregate_id])
  m.payload.invoices=[{id:r.id,status:r.status,posted_by:null,posted_at:null,paid_amount:r.paid_amount,
    payment_method:r.payment_method,snapshot:{supplier_id:source,invoice_number:r.invoice_number,notes:r.notes,
      total:r.total,created_at:r.created_at.toISOString(),items:op.payload.items},
    payments:payments.map(p=>({id:p.id,invoice_id:p.invoice_id,supplier_id:p.supplier_id,amount:p.amount,
      payment_method:p.payment_method,fund_source:p.fund_source,shift_id:p.shift_id,note:p.note,
      created_by:p.created_by,created_at:p.created_at.toISOString()}))}]
  return m
}
it('commits simultaneous paid invoice creation once with exactly one cash movement',async()=>{
  const op=await invoice(25)
  const result=await pair(()=>createInvoice(op),()=>createInvoice(op),'INSERT INTO supplier_invoice_copy_receipts')
  result.forEach(ok)
  expect(await rows('SELECT paid_amount FROM supply_invoices')).toEqual([{paid_amount:25}])
  expect(await rows('SELECT amount FROM supplier_payments')).toEqual([{amount:25}])
  expect(await rows('SELECT amount FROM cash_operations')).toEqual([{amount:25}]);await unchangedStock()
})
it('does not archive a supplier while an invoice creates its first reference',async()=>{
  const op=await invoice()
  const result=await pair(()=>createInvoice(op),()=>mergeEmptySupplier(target,source,tenant,at),'INSERT INTO supplier_invoice_copy_receipts')
  ok(result[0]);rejected(result[1],'SUPPLIER_MERGE_HISTORY')
  expect(await rows('SELECT supplier_id FROM supply_invoices')).toEqual([{supplier_id:source}])
})
it('rejects invoice creation after a competing empty merge wins',async()=>{
  const op=await invoice()
  const result=await pair(()=>mergeEmptySupplier(target,source,tenant,at),()=>createInvoice(op),'INSERT INTO supplier_merge_receipts')
  ok(result[0]);rejected(result[1],'SUPPLIER_MERGED')
  expect(await rows('SELECT * FROM supply_invoices')).toHaveLength(0)
})
it('concurrent paid invoice replay cannot duplicate cash during a full supplier transfer',async()=>{
  await put(upsert());const op=await invoice(25);await createInvoice(op)
  const m=await attachInvoice(await manifest(),op)
  const result=await pair(()=>merge(m),()=>createInvoice(op),'INSERT INTO supplier_merge_receipts')
  result.forEach(ok)
  expect(await rows('SELECT supplier_id,paid_amount FROM supply_invoices')).toEqual([{supplier_id:target,paid_amount:25}])
  expect(await rows('SELECT supplier_id,amount FROM supplier_payments')).toEqual([{supplier_id:target,amount:25}])
  expect(await rows('SELECT amount FROM cash_operations')).toEqual([{amount:25}]);await unchangedStock()
})
it('a new payment commits before a waiting stale transfer, which then rolls back',async()=>{
  await put(upsert());const op=await invoice();await createInvoice(op)
  const m=await attachInvoice(await manifest(),op),paymentOp=payment(op)
  const result=await pair(()=>payInvoice(paymentOp),()=>merge(m),'INSERT INTO cash_operations')
  ok(result[0]);rejected(result[1],'SYNC_INVOICE_COPY_CONFLICT')
  expect(await rows('SELECT supplier_id,paid_amount FROM supply_invoices')).toEqual([{supplier_id:source,paid_amount:75}])
  expect((await snapshot())[0].supplier_id).toBe(source)
  expect(await rows('SELECT * FROM supplier_merge_receipts')).toHaveLength(0);await unchangedStock()
})
it('a payment to the new supplier waits for the full catalog and invoice transfer',async()=>{
  await put(upsert());const op=await invoice();await createInvoice(op)
  const m=await attachInvoice(await manifest(),op),paymentOp=payment(op,target)
  const result=await pair(()=>merge(m),()=>payInvoice(paymentOp),'INSERT INTO supplier_merge_receipts')
  result.forEach(ok)
  const before=await snapshot();await merge(m);await payInvoice(paymentOp)
  expect(await snapshot()).toEqual(before)
  expect(await rows('SELECT supplier_id,paid_amount FROM supply_invoices')).toEqual([{supplier_id:target,paid_amount:75}])
  expect(await rows('SELECT amount FROM cash_operations')).toEqual([{amount:75}]);await unchangedStock()
})
it('keeps receipt tables private and append-only on the real PostgreSQL engine',async()=>{
  const permissions=await rows(`SELECT rolname,
    has_table_privilege(rolname,'supplier_catalog_copy_receipts','SELECT') AS read,
    has_table_privilege(rolname,'supplier_catalog_copy_receipts','INSERT') AS insert,
    has_table_privilege(rolname,'supplier_catalog_copy_receipts','UPDATE') AS update,
    has_table_privilege(rolname,'supplier_catalog_copy_receipts','DELETE') AS delete
    FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') ORDER BY rolname`)
  expect(permissions).toEqual([
    {rolname:'anon',read:false,insert:false,update:false,delete:false},
    {rolname:'authenticated',read:false,insert:false,update:false,delete:false},
    {rolname:'service_role',read:true,insert:true,update:false,delete:false},
  ])
  expect(await rows("SELECT relrowsecurity FROM pg_class WHERE oid='supplier_catalog_copy_receipts'::regclass"))
    .toEqual([{relrowsecurity:true}])
})
