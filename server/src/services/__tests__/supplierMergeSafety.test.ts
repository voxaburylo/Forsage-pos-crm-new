import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, beforeEach, it, expect, vi } from 'vitest'
const state = vi.hoisted(() => ({ db: null as any, fail: '' }))
vi.mock('../../db/supabase.js', () => ({ db: { rpc: () => { throw new Error('Stock RPC forbidden') } } }))
vi.mock('../../db/pg.js', () => ({ runTransaction: (fn: any) => state.db.transaction((tx: any) => fn({
  query: async (sql: string, args: any[]) => {
    if (state.fail && sql.includes(state.fail)) throw new Error('test failure')
    const result = await tx.query(sql, args)
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }
  },
})) }))
import { mergeEmptySupplier, assertSupplierNotMerged } from '../supplierMergeSafety.js'
import { applySupplierMerged, applySupplierUpsert } from '../sync/supplierHandlers.js'
const tenant = randomUUID(), other = randomUUID(), target = randomUUID(), source = randomUUID(), at = '2026-10-06T09:00:00Z'
const migration = readFileSync(new URL('../../../../supabase/migrations/20261006081852_supplier_empty_merge_receipts.sql', import.meta.url), 'utf8')
const rows = async (sql: string, args: any[] = []) => (await state.db.query(sql, args)).rows
const snap = async () => [await rows('SELECT * FROM suppliers ORDER BY id'), await rows('SELECT * FROM supplier_merge_receipts ORDER BY duplicate_id'), await rows('SELECT * FROM supply_invoices ORDER BY id')]
beforeAll(async () => {
  state.db = new PGlite()
  await state.db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE suppliers(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,name text,phone text,email text,contact_name text,notes text,is_active bool DEFAULT true,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz);
    CREATE TABLE supply_invoices(id uuid PRIMARY KEY,tenant_id uuid,supplier_id uuid REFERENCES suppliers,deleted_at timestamptz,amount int);
    CREATE TABLE supplier_price_items(id uuid PRIMARY KEY,tenant_id uuid,supplier_id uuid REFERENCES suppliers);
    CREATE TABLE future_refs(id uuid PRIMARY KEY,tenant_id uuid,vendor_ref uuid REFERENCES suppliers);
  `)
  await state.db.exec(migration)
})
afterAll(async () => state.db.close())
beforeEach(async () => {
  state.fail = ''
  await state.db.exec('TRUNCATE supplier_merge_receipts,supply_invoices,supplier_price_items,future_refs,suppliers CASCADE')
  await state.db.query('INSERT INTO suppliers(id,tenant_id,name,created_at,updated_at) VALUES($1,$2,$3,$4,$4),($5,$2,$6,$4,$4)', [target, tenant, 'Primary', at, source, 'Duplicate'])
})
const merge = () => mergeEmptySupplier(target, source, tenant, at)

it.each(['suppliers','supplier_merge_receipts'])('rejects silently skipped empty merge write to %s', async table => {
  await state.db.exec('CREATE FUNCTION skip_empty_merge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER skip_empty_merge BEFORE ' + (table === 'suppliers' ? 'UPDATE' : 'INSERT') + ' ON ' + table + ' FOR EACH ROW EXECUTE FUNCTION skip_empty_merge()')
  try {
    const before = await snap()
    await expect(merge()).rejects.toThrow()
    expect(await snap()).toEqual(before)
  } finally { await state.db.exec('DROP TRIGGER skip_empty_merge ON ' + table + '; DROP FUNCTION skip_empty_merge()') }
  await merge(); const after = await snap(); await merge(); expect(await snap()).toEqual(after)
})
const operation = (): any => ({ operation_type: 'supplier.merged', aggregate_id: target, operation_id: randomUUID(), tenant_id: tenant, device_id: 'local', sequence: 2, created_at: at, payload: { primary_supplier_id: target, duplicate_supplier_id: source } })


it.each(['archive','receipt','target'])('rejects wrong persisted empty merge %s', async kind => {
  const table=kind==='receipt'?'supplier_merge_receipts':'suppliers'
  const body=kind==='receipt'?"NEW.result:=jsonb_set(NEW.result,'{name}','\"Changed\"');":kind==='target'?"UPDATE suppliers SET name='Changed' WHERE id='"+target+"'::uuid;":'NEW.is_active:=true;'
  await state.db.exec('CREATE FUNCTION alter_empty() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN '+body+' RETURN NEW; END $$; CREATE TRIGGER alter_empty BEFORE '+(kind==='receipt'?'INSERT':'UPDATE')+' ON '+table+(kind==='target'?" FOR EACH ROW WHEN (OLD.id='"+source+"'::uuid)":" FOR EACH ROW")+' EXECUTE FUNCTION alter_empty()')
  try {const before=await snap();await expect(merge()).rejects.toThrow();expect(await snap()).toEqual(before)}
  finally {await state.db.exec('DROP TRIGGER alter_empty ON '+table+'; DROP FUNCTION alter_empty()')}
  await merge()
})

it('accepts the production server timestamp trigger during an empty merge', async () => {
  const deltaSql = readFileSync(new URL('../../../../supabase/migrations/20260801090000_sync_keyset_reference_deltas.sql', import.meta.url), 'utf8')
  const touchSql = deltaSql.slice(deltaSql.indexOf('CREATE OR REPLACE FUNCTION public.sync_touch_updated_at()'), deltaSql.indexOf('REVOKE ALL ON FUNCTION public.sync_touch_updated_at()'))
  await state.db.exec(touchSql)
  await state.db.exec('CREATE TRIGGER real_sync_touch BEFORE INSERT OR UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION public.sync_touch_updated_at()')
  try {
    await merge(); const after=await snap(); await merge(); expect(await snap()).toEqual(after)
    expect((await rows('SELECT updated_at FROM suppliers WHERE id=$1',[source]))[0].updated_at).not.toEqual(new Date(at))
  } finally {await state.db.exec('DROP TRIGGER real_sync_touch ON suppliers; DROP FUNCTION public.sync_touch_updated_at()')}
})

it('commits once and acknowledges the same pair after lost replies', async () => {
  const result = await merge(); const after = await snap()
  expect(await merge()).toEqual(JSON.parse(JSON.stringify(result)))
  expect(await snap()).toEqual(after)
  expect((await rows('SELECT * FROM suppliers WHERE id=$1', [source]))[0]).toMatchObject({ is_active: false, deleted_at: new Date(at) })
  expect((await rows('SELECT * FROM suppliers WHERE id=$1', [target]))[0].name).toBe('Primary')
})
it('uses the same guard for synchronization and preserves the source timestamp', async () => {
  await applySupplierMerged(tenant, operation()); const before = await snap()
  await applySupplierMerged(tenant, operation()); expect(await snap()).toEqual(before)
})
it('rejects mismatched sync tenant or aggregate instead of acknowledging', async () => {
  const before = await snap()
  await expect(applySupplierMerged(other, operation())).rejects.toThrow()
  await expect(applySupplierMerged(tenant, { ...operation(), aggregate_id: source })).rejects.toThrow()
  expect(await snap()).toEqual(before)
})
it.each(['self','missing','foreign','inactive','deleted'])('rejects invalid pair %s', async kind => {
  if (kind === 'foreign') await state.db.query('UPDATE suppliers SET tenant_id=$1 WHERE id=$2', [other, source])
  if (kind === 'inactive') await state.db.query('UPDATE suppliers SET is_active=false WHERE id=$1', [target])
  if (kind === 'deleted') await state.db.query('UPDATE suppliers SET deleted_at=$1 WHERE id=$2', [at, source])
  const before = await snap()
  await expect(mergeEmptySupplier(kind === 'self' ? source : target, kind === 'missing' ? randomUUID() : source, tenant, at)).rejects.toThrow()
  expect(await snap()).toEqual(before)
})
it.each(['active','deleted','foreign'])('never rewrites %s historical documents', async kind => {
  await state.db.query('INSERT INTO supply_invoices VALUES($1,$2,$3,$4,12345)', [randomUUID(), kind === 'foreign' ? other : tenant, source, kind === 'deleted' ? at : null])
  const before = await snap(); await expect(merge()).rejects.toThrow(/історією/); expect(await snap()).toEqual(before)
})
it.each(['supplier_price_items','future_refs'])('blocks nonfinancial or future references in %s', async table => {
  await state.db.query('INSERT INTO ' + table + ' VALUES($1,$2,$3)', [randomUUID(), other, source])
  const before = await snap(); await expect(merge()).rejects.toThrow(/історією/); expect(await snap()).toEqual(before)
})
it('leaves primary historical documents untouched', async () => {
  await state.db.query('INSERT INTO supply_invoices VALUES($1,$2,$3,NULL,12345)', [randomUUID(), tenant, target])
  const before = await rows('SELECT * FROM supply_invoices'); await merge(); expect(await rows('SELECT * FROM supply_invoices')).toEqual(before)
})
it.each(['UPDATE suppliers','INSERT INTO supplier_merge_receipts'])('rolls back on %s failure', async sql => {
  state.fail = sql; const before = await snap()
  await expect(merge()).rejects.toThrow('test failure'); expect(await snap()).toEqual(before)
  state.fail = ''; await merge(); await merge()
  expect(await rows('SELECT * FROM supplier_merge_receipts')).toHaveLength(1)
})
it('rejects another destination for an already merged source', async () => {
  await merge(); const third = randomUUID()
  await state.db.query('INSERT INTO suppliers(id,tenant_id,name) VALUES($1,$2,$3)', [third, tenant, 'Other'])
  const before = await snap(); await expect(mergeEmptySupplier(third, source, tenant)).rejects.toThrow(); expect(await snap()).toEqual(before)
})
it('rejects a stale supplier upsert instead of resurrecting a merged duplicate', async () => {
  await merge(); const before = await snap()
  await expect(applySupplierUpsert(tenant, { ...operation(), aggregate_id: source, operation_type: 'supplier.updated', payload: { id: source, name: 'Old form' } })).rejects.toThrow(/не відновлено/)
  expect(await snap()).toEqual(before)
})
it('rejects a foreign upsert without modifying the supplier', async () => {
  const before = await snap()
  await expect(applySupplierUpsert(other, { ...operation(), payload: { id: source, name: 'Foreign' } })).rejects.toThrow()
  expect(await snap()).toEqual(before)
})
it('rejects new invoice references to a merged source', async () => {
  await merge()
  const client = { query: async (sql: string, args: any[]) => { const result = await state.db.query(sql, args); return { ...result, rowCount: result.rows.length } } }
  await expect(assertSupplierNotMerged(client as any, tenant, source)).rejects.toThrow(/об’єднано/)
  await expect(assertSupplierNotMerged(client as any, tenant, target)).resolves.toBeUndefined()
})
it('enables RLS and keeps receipts append-only and unavailable to public clients', async () => {
  expect((await rows("SELECT relrowsecurity FROM pg_class WHERE relname='supplier_merge_receipts'"))[0].relrowsecurity).toBe(true)
  for (const role of ['anon','authenticated']) {
    expect((await rows("SELECT has_table_privilege($1,'supplier_merge_receipts','SELECT') AS allowed", [role]))[0].allowed).toBe(false)
    expect((await rows("SELECT has_table_privilege($1,'supplier_merge_receipts','INSERT') AS allowed", [role]))[0].allowed).toBe(false)
  }
  expect((await rows("SELECT has_table_privilege('service_role','supplier_merge_receipts','UPDATE') AS allowed"))[0].allowed).toBe(false)
  expect((await rows("SELECT has_table_privilege('service_role','supplier_merge_receipts','DELETE') AS allowed"))[0].allowed).toBe(false)
})
it.each([{}, { id: source }, []])('rejects invalid stored result %j', async result => {
  await expect(state.db.query('INSERT INTO supplier_merge_receipts(tenant_id,duplicate_id,primary_id,result,merged_at) VALUES($1,$2,$3,$4,$5)', [tenant, source, target, JSON.stringify(result), at])).rejects.toThrow()
})
