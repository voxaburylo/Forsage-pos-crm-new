import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalStaffRepository } from '../src/repositories/staffRepository'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'
import { activeSession } from '../src/security/activeSession'

describe('employee lifecycle on isolated local database', () => {
  it('refreshes role and revokes disabled, archived and non-login sessions without restarting', () => {
    create()
    const identity = { id: 'employee', tenant_id: DEFAULT_TENANT_ID }
    expect(activeSession(db, identity)?.role).toBe('cashier')
    staff.updateUser('employee', { role: 'manager' })
    const changed = activeSession(db, identity)!
    expect(changed.role).toBe('manager')
    expect(isDesktopChannelAllowed('desktop:pos:checkout', changed.role)).toBe(false)
    staff.updateUser('employee', { is_active: false })
    expect(activeSession(db, identity)).toBeNull()
    staff.updateUser('employee', { is_active: true, role: 'tire_worker' })
    expect(activeSession(db, identity)).toBeNull()
    // Defensive check: even an inconsistent archived+active row cannot log in.
    db.prepare("UPDATE staff_users SET role='cashier', is_active=1, deleted_at=? WHERE id=?")
      .run(new Date().toISOString(), identity.id)
    expect(activeSession(db, identity)).toBeNull()
    expect(activeSession(db, { ...identity, tenant_id: 'another-shop' })).toBeNull()
  })
  let dir: string, db: LocalDatabase, staff: LocalStaffRepository
  let reasons: string[]
  const phone = '+380671112233'
  const create = (id = 'employee', number = phone, role = 'cashier') => staff.saveServerUser({ id, phone: number, full_name: 'Тест', role }, 'original-password')
  const outboxFailure = () => db.prepare("CREATE TEMP TRIGGER fail_staff_outbox BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END").run()
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'forsage-lifecycle-')); db = new LocalDatabase(dir); reasons = []; staff = new LocalStaffRepository(db, reason => reasons.push(reason)) })
  afterEach(() => { db.close(); if(path.dirname(dir)===tmpdir() && path.basename(dir).startsWith('forsage-lifecycle-'))rmSync(dir,{recursive:true,force:true}) })

  it('create → login → change → archive → restart → restore → offline login preserves ID, password and PIN', () => {
    create(); staff.setPin('employee','1234')
    expect(staff.loginWithPassword('0671112233','original-password').id).toBe('employee')
    staff.updateUser('employee',{full_name:'Оновлене ім’я'})
    staff.deleteUser('employee')
    expect(staff.listUsers()).toHaveLength(0)
    expect(staff.listUsers(DEFAULT_TENANT_ID,true)[0].deleted_at).toBeTruthy()
    expect(()=>staff.loginWithPassword(phone,'original-password')).toThrow('LOCAL_AUTH_ARCHIVED')
    db.close(); db = new LocalDatabase(dir); staff = new LocalStaffRepository(db)
    staff.restoreUser('employee'); staff.restoreUser('employee')
    expect(staff.listUsers()).toHaveLength(1)
    expect(staff.loginWithPassword(phone,'original-password')).toMatchObject({id:'employee',full_name:'Оновлене ім’я'})
    expect(staff.verifyPin('employee','1234').valid).toBe(true)
    expect(db.prepare("SELECT count(*) n FROM sync_outbox WHERE operation_type='staff_user.updated'").get()).toMatchObject({n:2})
  })
  it('rejects equivalent phone formats in edits and restores without modifying either card', () => {
    create(); create('second','+380671112244')
    expect(()=>staff.updateUser('second',{phone:'067 111 22 33'})).toThrow('вже існує')
    staff.deleteUser('employee'); staff.updateUser('second',{phone:'0671112233'})
    expect(()=>staff.restoreUser('employee')).toThrow('іншому працівнику')
    expect(staff.listUsers()).toHaveLength(1)
  })
  it('preserves account and queue together if writing the outbox fails', () => {
    create(); outboxFailure()
    expect(()=>staff.updateUser('employee',{full_name:'Не збережеться'})).toThrow('simulated')
    expect(()=>staff.deleteUser('employee')).toThrow('simulated')
    expect(staff.listUsers()[0]).toMatchObject({full_name:'Тест',is_active:true})
  })
  it('rolls back restore if the queue cannot record it', () => {
    create(); staff.deleteUser('employee'); outboxFailure()
    expect(()=>staff.restoreUser('employee')).toThrow('simulated')
    expect(staff.listUsers()).toEqual([])
  })
  it('saves profile and commissions atomically, preserving category rules', () => {
    create()
    staff.createCommissionRule({user_id:'employee',rule_type:'pos_sales',pct_from_revenue:5})
    staff.saveUserSettings('employee',{base_rate:10000},[{rule_type:'pos_sales',pct_from_revenue:7,pct_from_profit:0}])
    const category = new LocalCatalogRepository(db).createCategory('Спеціальна категорія')
    staff.createCommissionRule({user_id:'employee',rule_type:'pos_sales',category_id:category.id,pct_from_revenue:2})
    expect(staff.listCommissionRules()).toHaveLength(2)
    const before = staff.listCommissionRules()
    const queued = db.prepare('SELECT count(*) n FROM sync_outbox').get()
    db.prepare("CREATE TEMP TRIGGER fail_rule_insert BEFORE INSERT ON commission_rules BEGIN SELECT RAISE(ABORT, 'simulated rule failure'); END").run()
    expect(()=>staff.saveUserSettings('employee',{base_rate:20000},[{rule_type:'pos_sales',pct_from_revenue:9,pct_from_profit:0}])).toThrow('simulated')
    expect(staff.listUsers()[0].base_rate).toBe(10000)
    expect(staff.listCommissionRules()).toEqual(before)
    expect(db.prepare('SELECT count(*) n FROM sync_outbox').get()).toEqual(queued)
    db.prepare('DROP TRIGGER fail_rule_insert').run()
    staff.saveUserSettings('employee',{},[])
    expect(staff.listCommissionRules()).toMatchObject([{category_id:category.id,pct_from_revenue:2}])
  })
  it('rejects invalid percentages before any profile or rule changes', () => {
    create(); staff.createCommissionRule({user_id:'employee',pct_from_revenue:5})
    for(const value of [NaN,Infinity,-1,101])expect(()=>staff.saveUserSettings('employee',{full_name:'Інше'},[{rule_type:'pos_sales',pct_from_revenue:value,pct_from_profit:0}])).toThrow('Відсоток')
    expect(staff.listUsers()[0].full_name).toBe('Тест')
    expect(staff.listCommissionRules()).toHaveLength(1)
  })
  it('reports the reason without recording passwords or phones', () => {
    create(); expect(()=>staff.loginWithPassword(phone,'wrong')).toThrow('Невірний')
    staff.updateUser('employee',{is_active:false})
    expect(()=>staff.loginWithPassword(phone,'original-password')).toThrow('LOCAL_AUTH_DISABLED')
    expect(reasons).toEqual(['password-mismatch','account-disabled'])
  })
  it('password reset clears an earlier lockout', () => {
    create(); for(let i=0;i<10;i++)try{staff.loginWithPassword(phone,'bad')}catch{}
    staff.saveServerPassword('employee','new-password')
    expect(staff.loginWithPassword(phone,'new-password').id).toBe('employee')
  })
  it('protects the last owner and restricts lifecycle commands to administrators', () => {
    create('owner',phone,'owner')
    expect(()=>staff.deleteUser('owner')).toThrow('останнього власника')
    expect(()=>staff.updateUser('owner',{role:'cashier'})).toThrow('останнього власника')
    for(const channel of ['desktop:staff:restore-user','desktop:staff:save-settings','desktop:staff:list-users']) {
      for(const role of ['cashier','manager','tire_worker','storekeeper'])expect(isDesktopChannelAllowed(channel,role)).toBe(false)
      for(const role of ['owner','admin'])expect(isDesktopChannelAllowed(channel,role)).toBe(true)
    }
  })
  it('does not truncate monthly salary totals to the last 200 records', () => {
    create()
    const insert = db.prepare("INSERT INTO salary_payments(id,tenant_id,employee_id,employee_name,amount,type,method,period,work_date,created_at,updated_at) VALUES(?,?,'employee','Тест',100,'bonus','transfer','2026-09','2026-09-16','2026-09-16','2026-09-16')")
    db.transaction(()=>{for(let i=0;i<205;i++)insert.run(`pay-${i}`,DEFAULT_TENANT_ID)})
    expect(staff.listSalary({period:'2026-09'})).toHaveLength(200)
    expect(staff.salarySummary('2026-09')).toMatchObject([{earned:20500,balance:20500}])
    expect(staff.salarySummary('2026-08')).toEqual([])
  })
})
