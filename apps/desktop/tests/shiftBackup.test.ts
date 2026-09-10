import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { afterEach,beforeEach,describe,it,expect } from 'vitest'
import * as XLSX from 'xlsx'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { exportShiftSnapshot } from '../src/backup/shiftExportWorker'
import { ShiftBackupService } from '../src/backup/shiftBackupService'
import { customerHistory } from '../src/repositories/customerHistory'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'

describe('shift backups and full customer history',()=>{
  let root:string,db:LocalDatabase,pos:LocalPosRepository,cashier:string
  beforeEach(()=>{
    root=mkdtempSync(path.join(tmpdir(),'forsage-shift-export-'));db=new LocalDatabase(root);pos=new LocalPosRepository(db);cashier=randomUUID()
    db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(cashier,DEFAULT_TENANT_ID,'Тест','cashier',new Date().toISOString(),new Date().toISOString())
  })
  afterEach(()=>{
    db.close()
    if(path.dirname(root)===path.resolve(tmpdir())&&path.basename(root).startsWith('forsage-shift-export-'))rmSync(root,{recursive:true,force:true})
  })
  it('commits the backup job with shift close, never closes twice',()=>{
    const id=pos.openShift({cashier_id:cashier,opening_cash:0})
    pos.closeShift(cashier,0,null)
    expect(db.prepare('SELECT id,device_id FROM shift_backups').all()).toEqual([{id,device_id:db.deviceId}])
    expect(()=>pos.closeShift(cashier,0,null)).toThrow()
    expect(db.prepare('SELECT count(*) n FROM shift_backups').get()).toEqual({n:1})
  })
  it('rolls back both close and job when recording the backup job fails',()=>{
    const id=pos.openShift({cashier_id:cashier})
    db.exec("CREATE TRIGGER fail_job BEFORE INSERT ON shift_backups BEGIN SELECT RAISE(ABORT,'test failure'); END")
    expect(()=>pos.closeShift(cashier,0,null)).toThrow('test failure')
    expect(db.prepare('SELECT status FROM shifts WHERE id=?').get(id)).toEqual({status:'open'})
  })
  it('resumes a failed export from the original snapshot without changing closed stock',async()=>{
    const product=new LocalCatalogRepository(db).upsertProduct({id:randomUUID(),sku:'RECOVER',name:'Відновлення',qty_on_hand:8})
    const id=pos.openShift({cashier_id:cashier});pos.closeShift(cashier,0,null)
    const first=new ShiftBackupService(db,path.join(root,'program'),()=>{},async()=>{throw Error('disk full')})
    await first.tick()
    expect((db.prepare('SELECT local_error FROM shift_backups WHERE id=?').get(id) as any).local_error).toBe('disk full')
    db.prepare('UPDATE products SET qty_on_hand=3 WHERE id=?').run(product.id)
    db.prepare('UPDATE shift_backups SET next_attempt_at=NULL WHERE id=?').run(id)
    const restarted=new ShiftBackupService(db,path.join(root,'program'),()=>{},exportShiftSnapshot)
    await restarted.tick()
    const job=db.prepare('SELECT * FROM shift_backups WHERE id=?').get(id) as any
    expect(job.local_error).toBeNull();expect(job.sha256).toHaveLength(64)
    const {readdirSync}=await import('node:fs')
    const file=readdirSync(job.export_directory).find(name=>name.startsWith('Товари'))!
    const sheet=XLSX.read(readFileSync(path.join(job.export_directory,file)),{type:'buffer'}).Sheets['Товари']
    expect(sheet.H2.v).toBe(8)
    expect(db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get(product.id)).toEqual({qty_on_hand:3})
    await expect(restarted.upload(DEFAULT_TENANT_ID,id,'https://attacker.invalid/upload','https://trusted.supabase.co')).rejects.toThrow('Неприпустима')
    expect(restarted.pending(randomUUID())).toEqual([])
    restarted.confirmed(DEFAULT_TENANT_ID,id,job.sha256)
    expect(restarted.pending(DEFAULT_TENANT_ID)).toEqual([])
  })
  it('writes typed XLSX files from the same verified snapshot and a restorable gzip',async()=>{
    new LocalCatalogRepository(db).upsertProduct({id:randomUUID(),sku:'0007',barcode:'0000123456789',name:'=Не формула',qty_on_hand:3.5,purchase_price:12345,retail_price:20000,unit:'кг'})
    pos.saveCustomer({phone:'0500000000',full_name:'Тест',card_barcode:'0000123',notes:'=1+1'})
    const snapshot=await db.backupNow()
    const result=await exportShiftSnapshot({snapshot,output:path.join(root,'exports'),tenantId:DEFAULT_TENANT_ID,stamp:'2026-09-10_test',closedAt:'2026-09-10T18:00:00Z',capturedAt:'2026-09-10T18:00:01Z'})
    const product=XLSX.read(readFileSync(result.productFile),{type:'buffer'}).Sheets['Товари']
    expect(product.B2).toMatchObject({t:'s',v:'0007'})
    expect(product.C2).toMatchObject({t:'s',v:'0000123456789'})
    expect(product.D2).toMatchObject({t:'s',v:'=Не формула'})
    expect(product.D2.f).toBeUndefined()
    expect(product.H2.v).toBe(3.5);expect(product.I2.v).toBe(123.45)
    const customer=XLSX.read(readFileSync(result.customerFile),{type:'buffer'}).Sheets['Клієнти']
    expect(customer.C2).toMatchObject({t:'s',v:'0500000000'})
    expect(customer.K2.f).toBeUndefined()
    expect(gunzipSync(readFileSync(result.compressed))).toEqual(readFileSync(snapshot))
    expect(result.products).toBe(1);expect(result.customers).toBe(1)
    LocalDatabase.assertBackupIsUsable(snapshot)
  })
  it('pages all 231 receipts and isolates tenant/date filters',()=>{
    const customer=pos.saveCustomer({phone:'0500000001',full_name:'Історія'}).data.id
    const ts='2026-09-10T12:00:00.000Z'
    const shift=pos.openShift({cashier_id:cashier})
    db.transaction(()=>{
      for(let i=0;i<231;i++) db.prepare(`INSERT INTO sales(id,tenant_id,sale_number,customer_id,cashier_id,shift_id,status,total,payment_method,completed_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'completed',100,'cash',?,?,?)`).run(randomUUID(),DEFAULT_TENANT_ID,String(i),customer,cashier,shift,ts,ts,ts)
    })
    const ids:string[]=[]
    for(let offset=0;offset<250;offset+=50){
      const page=customerHistory(db,DEFAULT_TENANT_ID,customer,'sales',{offset,limit:50})
      ids.push(...page.data.map(row=>String(row.id)))
      if(!page.has_more)break
    }
    expect(new Set(ids).size).toBe(231)
    expect(customerHistory(db,randomUUID(),customer,'sales').data).toEqual([])
    expect(customerHistory(db,DEFAULT_TENANT_ID,customer,'sales',{from:'2026-09-11T00:00:00.000Z'}).data).toEqual([])
    expect(()=>customerHistory(db,DEFAULT_TENANT_ID,customer,'sales',{offset:-1})).toThrow()
  })
})
