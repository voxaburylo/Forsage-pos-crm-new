import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalStaffRepository } from '../src/repositories/staffRepository'
import { assertLanIdentityConnection, cacheLanIdentity, canPairEmptyClient, hasLanIdentity, loginLanClient } from '../src/lan/clientIdentity'
import { LanUnavailableError } from '../src/lan/orderQueue'

describe('manager first login without internet', () => {
  let root:string, db:LocalDatabase, staff:LocalStaffRepository
  const phone='+380671112233', password='local-manager-pass', key='0123456789abcdef0123456789abcdef'
  const profile={id:'manager-1',tenant_id:DEFAULT_TENANT_ID,role:'manager',full_name:'Менеджер',phone,is_active:true}
  beforeEach(()=>{root=mkdtempSync(path.join(tmpdir(),'forsage-lan-identity-'));db=new LocalDatabase(root);staff=new LocalStaffRepository(db)})
  afterEach(()=>{db.close();if(path.dirname(root)===tmpdir()&&path.basename(root).startsWith('forsage-lan-identity-'))rmSync(root,{recursive:true,force:true})})
  it('reproduces the old empty-profile blocker even with a verified server password',()=>{
    expect(()=>staff.adoptServerAuthenticatedPassword(profile.id,phone,password)).toThrow('не відповідає локальному')
  })
  it('allows pairing only before any staff/shop data and no pending orders',()=>{
    expect(canPairEmptyClient(db,'standalone',false)).toBe(true)
    expect(canPairEmptyClient(db,'hub',false)).toBe(false)
    expect(canPairEmptyClient(db,'client',false)).toBe(false)
    expect(canPairEmptyClient(db,'standalone',true)).toBe(false)
    staff.saveServerUser(profile,password)
    expect(canPairEmptyClient(db,'standalone',false)).toBe(false)
  })
  it('caches only a hub-confirmed identity and protected hash without cloud outbox or inventory',async()=>{
    const result=await loginLanClient({remote:async()=>profile,cache:p=>cacheLanIdentity(db,p,phone,password,key),local:()=>staff.loginWithPassword(phone,password)})
    expect(result.id).toBe(profile.id)
    expect(hasLanIdentity(db)).toBe(true)
    expect(db.prepare('SELECT password_hash FROM staff_users').get()).toEqual({password_hash:expect.stringMatching(/^pbkdf2-/)})
    expect(db.prepare('SELECT count(*) n FROM sync_outbox').get()).toEqual({n:0})
    expect(db.prepare('SELECT count(*) n FROM products').get()).toEqual({n:0})
    expect(canPairEmptyClient(db,'standalone',false)).toBe(false)
  })
  it('permits cached offline entry only for a transport failure',async()=>{
    cacheLanIdentity(db,profile,phone,password,key)
    const local=vi.fn(()=>staff.loginWithPassword(phone,password))
    await expect(loginLanClient({remote:async()=>{throw new LanUnavailableError('offline')},cache:vi.fn(),local})).resolves.toMatchObject({id:profile.id})
    expect(local).toHaveBeenCalledTimes(1)
    for(const error of ['Невірний пароль','Доступ вимкнено','Невірний код','Несумісні версії']){
      await expect(loginLanClient({remote:async()=>{throw new Error(error)},cache:vi.fn(),local})).rejects.toThrow(error)
    }
    expect(local).toHaveBeenCalledTimes(1)
  })
  it('does not silently enter a new computer offline',async()=>{
    await expect(loginLanClient({remote:async()=>{throw new LanUnavailableError('offline')},cache:vi.fn(),local:()=>staff.loginWithPassword(phone,password)})).rejects.toThrow()
  })
  it.each([
    {tenant_id:'other-shop'},{role:'cashier'},{is_active:false},{phone:'+380671110000'},{full_name:''},{id:"id';DROP TABLE staff_users"},
  ])('rejects invalid hub identity %j without writes',change=>{
    expect(()=>cacheLanIdentity(db,{...profile,...change},phone,password,key)).toThrow()
    expect(hasLanIdentity(db)).toBe(false)
    expect(db.prepare('SELECT count(*) n FROM staff_users').get()).toEqual({n:0})
  })
  it('refuses to overwrite independent staff data or shop products',()=>{
    staff.saveServerUser(profile,password)
    expect(()=>cacheLanIdentity(db,profile,phone,password,key)).toThrow('чистого профілю')
    db.prepare('DELETE FROM staff_users').run()
    const now=new Date().toISOString()
    db.prepare('INSERT INTO products(id,tenant_id,sku,name,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('p',DEFAULT_TENANT_ID,'SKU','Товар',now,now)
    expect(canPairEmptyClient(db,'standalone',false)).toBe(false)
    expect(()=>cacheLanIdentity(db,profile,phone,password,key)).toThrow('дані окремого магазину')
  })
  it('refreshes password and role from the same hub, never merges another pairing',()=>{
    cacheLanIdentity(db,profile,phone,password,key)
    cacheLanIdentity(db,{...profile,role:'admin'},phone,'new-password',key)
    expect(staff.loginWithPassword(phone,'new-password').role).toBe('admin')
    expect(()=>staff.loginWithPassword(phone,password)).toThrow()
    expect(()=>cacheLanIdentity(db,profile,phone,password,'fedcba9876543210fedcba9876543210')).toThrow('іншому підключенню')
  })
  it('fails closed when a cached manager loses configuration or gets a different hub key', () => {
    const valid = { mode: 'client', accessKey: key, hubAddress: '192.168.1.5:3210', secureTransport: 1 as const }
    expect(() => assertLanIdentityConnection(db, { mode: 'standalone', accessKey: '' })).not.toThrow()
    cacheLanIdentity(db, profile, phone, password, key)
    expect(() => assertLanIdentityConnection(db, valid)).not.toThrow()
    for (const config of [
      { mode: 'standalone', accessKey: key }, { mode: 'hub', accessKey: key },
      { mode: 'client', accessKey: '' }, { mode: 'client', accessKey: 'fedcba9876543210fedcba9876543210' },
      { ...valid, secureTransport: undefined }, { ...valid, hubAddress: '' }, { ...valid, hubAddress: 'example.com' },
    ]) expect(() => assertLanIdentityConnection(db, config)).toThrow('незалежну касу не відкрито')
    db.prepare("UPDATE app_meta SET value_json='invalid' WHERE key='lan-client-identity:v1'").run()
    expect(() => assertLanIdentityConnection(db, valid)).toThrow('пошкоджено')
    expect(staff.loginWithPassword(phone, password).id).toBe(profile.id)
  })
  it('does not strand pending orders by switching the cached employee on the same hub', () => {
    cacheLanIdentity(db, profile, phone, password, key)
    const queueKey = 'lan-order-workspace:v1:synthetic'
    const queued = JSON.stringify({ drafts: [{ jobs: [{ operationId: 'pending-order' }] }], cache: {} })
    db.prepare('INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?)').run(queueKey, queued, new Date().toISOString())
    expect(() => cacheLanIdentity(db, { ...profile, id: 'manager-2' }, phone, password, key)).toThrow('попереднього працівника')
    expect(staff.loginWithPassword(phone, password).id).toBe(profile.id)
    expect(db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(queueKey)).toEqual({ value_json: queued })
    expect(() => cacheLanIdentity(db, { ...profile, role: 'admin' }, phone, password, key)).not.toThrow()
    db.prepare('UPDATE app_meta SET value_json=? WHERE key=?').run(JSON.stringify({ drafts: [], cache: {} }), queueKey)
    cacheLanIdentity(db, { ...profile, id: 'manager-2' }, phone, password, key)
    expect(staff.loginWithPassword(phone, password).id).toBe('manager-2')
  })
})
