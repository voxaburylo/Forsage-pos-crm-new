import { PGlite } from '@electric-sql/pglite'
import { beforeEach,afterEach,expect,it } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const sql=readFileSync(new URL('../../../../supabase/migrations/20261005133848_return_copy_shift_identity.sql',import.meta.url),'utf8')
const tenant=randomUUID(),foreign=randomUUID(),shift=randomUUID(),other=randomUUID(),legacy=randomUUID()
let db:PGlite
beforeEach(async()=>{
 db=new PGlite()
 await db.exec(`
 CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE TABLE shifts(id uuid PRIMARY KEY,tenant_id uuid NOT NULL);
 CREATE TABLE returns(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,status text,refund_method text,refund_kopecks int,updated_at timestamptz);
 ALTER TABLE returns ENABLE ROW LEVEL SECURITY;
 CREATE POLICY existing_returns_policy ON returns TO authenticated USING(false) WITH CHECK(false);
 INSERT INTO shifts VALUES('${shift}','${tenant}'),('${other}','${foreign}');
 INSERT INTO returns VALUES('${legacy}','${tenant}','completed','terminal',1200,'2026-10-01T10:00Z');
 `)
})
afterEach(async()=>{await db.close()})
const migrate=()=>db.exec(sql)
const rows=async(sql:string,args:unknown[]=[]) => (await db.query(sql,args)).rows as any[]
async function linked(id=randomUUID(),target=shift,recorded=true) {
 return db.query("INSERT INTO returns(id,tenant_id,status,refund_method,refund_kopecks,shift_id,shift_link_recorded) VALUES($1,$2,'completed','terminal',1200,$3,$4)",[id,tenant,target,recorded])
}
it('adds nullable metadata without assigning historical returns or changing money',async()=>{
 const before=await rows('SELECT * FROM returns')
 await migrate()
 expect(await rows('SELECT id,tenant_id,status,refund_method,refund_kopecks,updated_at FROM returns')).toEqual(before)
 expect(await rows('SELECT shift_id,shift_link_recorded FROM returns')).toEqual([{shift_id:null,shift_link_recorded:false}])
})
it('is repeatable without changing stored known and unknown links',async()=>{
 await migrate();await linked()
 const before=await rows('SELECT * FROM returns ORDER BY id')
 await migrate()
 expect(await rows('SELECT * FROM returns ORDER BY id')).toEqual(before)
})
it.each(['missing','other tenant'])('foreign key rejects %s shift',async(kind)=>{
 await migrate()
 await expect(linked(randomUUID(),kind==='missing'?randomUUID():other)).rejects.toMatchObject({code:'23503'})
 expect(await rows('SELECT id FROM returns')).toEqual([{id:legacy}])
})
it('rejects a non-null shift falsely marked unknown',async()=>{
 await migrate()
 await expect(linked(randomUUID(),shift,false)).rejects.toMatchObject({code:'23514'})
})
it('protects a referenced shift from deletion and tenant reassignment',async()=>{
 await migrate();await linked()
 await expect(db.query('DELETE FROM shifts WHERE id=$1',[shift])).rejects.toMatchObject({code:'23001'})
 await expect(db.query('UPDATE shifts SET tenant_id=$1 WHERE id=$2',[foreign,shift])).rejects.toMatchObject({code:'23001'})
 expect(await rows('SELECT id,tenant_id FROM shifts WHERE id=$1',[shift])).toEqual([{id:shift,tenant_id:tenant}])
})
it.each(['move','clear','forget'])('an immutable completed link cannot %s, even in a sync transaction',async(kind)=>{
 await migrate();const id=randomUUID();await linked(id)
 await expect(db.transaction(async tx=>{
  await tx.query("SELECT set_config('app.sync_mode','true',true)")
  if(kind==='move')await tx.query('UPDATE returns SET shift_id=$1 WHERE id=$2',[other,id])
  if(kind==='clear')await tx.query('UPDATE returns SET shift_id=NULL WHERE id=$1',[id])
  if(kind==='forget')await tx.query('UPDATE returns SET shift_link_recorded=false WHERE id=$1',[id])
 })).rejects.toThrow('RETURN_SHIFT_IMMUTABLE')
 expect((await rows('SELECT shift_id,shift_link_recorded FROM returns WHERE id=$1',[id]))[0]).toEqual({shift_id:shift,shift_link_recorded:true})
})
it('does not allow ordinary updates to claim an unverified old link',async()=>{
 await migrate()
 await expect(db.query('UPDATE returns SET shift_id=$1,shift_link_recorded=true WHERE id=$2',[shift,legacy])).rejects.toThrow('RETURN_SHIFT_IMMUTABLE')
})
it.each([true,false])('trusted enrichment records a verified link or explicit absence: %s',async(hasShift)=>{
 await migrate()
 await db.transaction(async tx=>{
  await tx.query("SELECT set_config('app.sync_mode','true',true)")
  await tx.query('UPDATE returns SET shift_id=$1,shift_link_recorded=true WHERE id=$2',[hasShift?shift:null,legacy])
 })
 expect((await rows('SELECT shift_id,shift_link_recorded,refund_kopecks FROM returns'))[0]).toEqual({shift_id:hasShift?shift:null,shift_link_recorded:true,refund_kopecks:1200})
})
it('preserves existing RLS and exposes no privileged callable function',async()=>{
 const policies=await rows("SELECT policyname,roles,qual,with_check FROM pg_policies WHERE tablename='returns'")
 await migrate()
 expect(await rows("SELECT policyname,roles,qual,with_check FROM pg_policies WHERE tablename='returns'")).toEqual(policies)
 expect((await rows("SELECT relrowsecurity FROM pg_class WHERE oid='returns'::regclass"))[0].relrowsecurity).toBe(true)
 expect((await rows("SELECT prosecdef,proconfig FROM pg_proc WHERE oid='guard_return_shift_identity()'::regprocedure"))[0])
   .toEqual({prosecdef:false,proconfig:['search_path=public, pg_temp']})
 for(const role of ['anon','authenticated'])expect((await rows("SELECT has_function_privilege($1,'guard_return_shift_identity()','EXECUTE') allowed",[role]))[0].allowed).toBe(false)
 expect((await rows("SELECT has_function_privilege('service_role','guard_return_shift_identity()','EXECUTE') allowed"))[0].allowed).toBe(true)
})
it('has a same-tenant composite foreign key and a referencing index',async()=>{
 await migrate()
 const indexes=await rows("SELECT indexdef FROM pg_indexes WHERE tablename='returns'")
 expect(indexes.some(row=>row.indexdef.includes('(tenant_id, shift_id)'))).toBe(true)
 const fk=await rows("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='returns_shift_same_tenant'")
 expect(fk[0].definition).toContain('FOREIGN KEY (tenant_id, shift_id) REFERENCES shifts(tenant_id, id)')
})
it('rolls the entire migration back when pre-existing metadata is inconsistent instead of repairing it',async()=>{
 await db.exec('ALTER TABLE returns ADD COLUMN shift_id uuid')
 await db.query('UPDATE returns SET shift_id=$1',[shift])
 await expect(migrate()).rejects.toMatchObject({code:'23514'})
 await db.exec('ROLLBACK')
 expect(await rows("SELECT column_name FROM information_schema.columns WHERE table_name='returns' AND column_name='shift_link_recorded'")).toEqual([])
 expect((await rows('SELECT shift_id,refund_kopecks FROM returns'))[0]).toEqual({shift_id:shift,refund_kopecks:1200})
})
