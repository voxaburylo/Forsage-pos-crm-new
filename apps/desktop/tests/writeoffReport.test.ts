import { mkdtempSync,rmSync,readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach,afterEach,it,expect,vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalWarehouseRepository } from '../src/repositories/warehouseRepository'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'
let root:string,db:LocalDatabase,warehouse:LocalWarehouseRepository
const at='2026-10-05T10:00:00.000Z'
beforeEach(()=>{
 root=mkdtempSync(path.join(tmpdir(),'forsage-writeoff-report-'));db=new LocalDatabase(root);warehouse=new LocalWarehouseRepository(db)
 db.prepare('INSERT INTO products(id,tenant_id,sku,name,purchase_price,created_at,updated_at) VALUES(?,?,?,?,999,?,?)').run('p',tenant,'P','Тест',at,at)
})
afterEach(()=>{db.close();if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-writeoff-report-'))rmSync(root,{recursive:true,force:true})})
function act(id='w',time=at,shop=tenant,cost=123){
 db.prepare("INSERT INTO writeoffs(id,tenant_id,reason,created_at,updated_at) VALUES(?,?,'damage',?,?)").run(id,shop,time,time)
 db.prepare("INSERT INTO writeoff_items(id,tenant_id,writeoff_id,product_id,qty,cost_kopecks,created_at,updated_at) VALUES(?,?,?,'p',1,?,?,?)").run(id,shop,id,cost,time,time)
}
const run=(month='2026-10')=>warehouse.writeoffsSummary({month})
it('reads one snapshot and never rewrites source data or queue',()=>{
 act();const snapshot=vi.spyOn(db,'readSnapshot'),prepare=vi.spyOn(db,'prepare')
 db.exec('PRAGMA query_only=ON')
 expect(run()).toMatchObject({count:1,total_cost:123,month:'2026-10'})
 expect(snapshot).toHaveBeenCalledTimes(1);expect(prepare).toHaveBeenCalledTimes(2)
 expect(db.prepare('SELECT count(*) n FROM sync_outbox').get()).toMatchObject({n:0})
})
it('keeps original cost after restart and a catalog price change',()=>{
 act();db.close();db=new LocalDatabase(root);warehouse=new LocalWarehouseRepository(db)
 db.prepare('UPDATE products SET purchase_price=25000,deleted_at=?').run(at)
 expect(run().total_cost).toBe(123)
})
it('honours exact Kyiv month bounds rather than workstation timezone',()=>{
 act('before','2026-09-30T20:59:59.999Z');act('first','2026-10-01T00:00:00+03:00')
 act('last','2026-10-31T21:59:59.999Z');act('after','2026-11-01T00:00:00+02:00')
 expect(run().writeoffs.map(w=>w.id)).toEqual(['last','first'])
})
it('returns true zero for empty months and zero-cost acts',()=>{
 expect(run()).toMatchObject({count:0,total_cost:0,writeoffs:[]});act('zero',at,tenant,0)
 expect(run()).toMatchObject({count:1,total_cost:0})
})
it('excludes foreign and deleted headers without losing archived product history',()=>{
 act();act('other',at,'other');act('deleted')
 db.prepare('UPDATE writeoffs SET deleted_at=? WHERE id=?').run(at,'deleted')
 db.prepare('UPDATE products SET deleted_at=?').run(at)
 expect(run().writeoffs.map(w=>w.id)).toEqual(['w'])
})
it.each(['empty','deleted line','foreign line','foreign product','negative cost','fractional cost','string cost','zero qty','precision','reason','date'])('rejects corrupt %s without lowering the result',kind=>{
 act()
 const sql:Record<string,string>={
 empty:'DELETE FROM writeoff_items','deleted line':"UPDATE writeoff_items SET deleted_at='2026-10-05'",
 'foreign line':"UPDATE writeoff_items SET tenant_id='other'",'foreign product':"UPDATE products SET tenant_id='other'",
 'negative cost':'UPDATE writeoff_items SET cost_kopecks=-1','fractional cost':'UPDATE writeoff_items SET cost_kopecks=.5',
 'string cost':"UPDATE writeoff_items SET cost_kopecks='unknown'",'zero qty':'UPDATE writeoff_items SET qty=0',
 precision:'UPDATE writeoff_items SET qty=.0001',reason:"UPDATE writeoffs SET reason='unknown'",date:"UPDATE writeoffs SET created_at='bad'"}
 db.exec(sql[kind]);expect(run).toThrow('неповні')
})
it('loads more than 1000 acts with two data queries',()=>{
 db.transaction(()=>{for(let i=0;i<1205;i++)act('w'+i,at,tenant,1)})
 const query=vi.spyOn(db,'prepare');expect(run()).toMatchObject({count:1205,total_cost:1205});expect(query).toHaveBeenCalledTimes(2)
})
it.each(['','2026-13','2026-1','2026-10-01',null])('rejects invalid month %s',month=>expect(()=>run(month as any)).toThrow('місяць'))
it('uses the identical calculation on server and local runtime',()=>{
 const local=readFileSync(path.resolve('src/lib/writeoffReport.ts'),'utf8').replace(/\r\n/g,'\n')
 const remote=readFileSync(path.resolve('../../server/src/lib/writeoffReport.ts'),'utf8').replace(/\r\n/g,'\n')
 expect(local).toBe(remote)
})
it('keeps report rights equal to the server and does not add cashier financial access',()=>{
 for(const role of ['owner','admin','manager'])expect(isDesktopChannelAllowed('desktop:warehouse:writeoffs-summary',role)).toBe(true)
 for(const role of ['cashier','storekeeper','tire_worker','sto_viewer'])expect(isDesktopChannelAllowed('desktop:warehouse:writeoffs-summary',role)).toBe(false)
})
