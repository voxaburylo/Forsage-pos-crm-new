import { describe, it, expect, beforeEach } from 'vitest'
import { RememberedAccess, endOfAccessDay, localAccessDay, type RememberedUser } from '../src/security/rememberedAccess'
import { hashSecret } from '../src/security/secretHash'
import { isDesktopChannelAllowed, PUBLIC_DESKTOP_CHANNELS } from '../src/security/desktopAuthorization'

describe('calendar-day local login', () => {
  let stored: string | null, now: number, user: RememberedUser, missing: boolean
  const passwordHash = hashSecret('test-only-password')
  function open() {
    return new RememberedAccess({
      read: () => stored, write: value => { stored = value }, now: () => now,
      encrypt: text => Buffer.from(text).toString('base64'),
      decrypt: text => Buffer.from(text,'base64').toString(),
      user: (id,tenant) => !missing && id===user.id && tenant===user.tenant_id ? user : null,
    })
  }
  beforeEach(() => {
    stored=null; now=Date.parse('2026-09-26T07:30:00Z'); missing=false
    user={id:'cashier',tenant_id:'store',role:'cashier',phone:'+380000000000',full_name:'Test',password_hash:passwordHash,is_active:1,deleted_at:null}
  })
  it('restores after restart without a PIN, exposing no credentials', () => {
    open().remember(user)
    const restored=open().restore()
    expect(restored?.id).toBe(user.id)
    expect(restored).not.toHaveProperty('password_hash')
    expect(restored).not.toHaveProperty('pin_hash')
    expect(Buffer.from(stored!,'base64').toString()).not.toContain(passwordHash)
    expect(open().status()).toEqual({phone:user.phone,name:user.full_name,expiresAt:Date.parse('2026-09-26T21:00:00Z')})
  })
  it('does not extend access on restart, restore or status checks', () => {
    open().remember(user); const original=stored
    now=Date.parse('2026-09-26T20:59:59.999Z')
    expect(open().restore()?.id).toBe(user.id); expect(stored).toBe(original)
    now++
    expect(open().restore()).toBeNull(); expect(stored).toBeNull()
  })
  it('a login one minute before midnight lasts one minute, not 24 hours', () => {
    now=Date.parse('2026-09-26T20:59:00Z'); open().remember(user)
    expect(open().status()?.expiresAt! - now).toBe(60000)
  })
  it.each([
    ['2026-03-28T22:00:00Z','2026-03-29T21:00:00Z',23],
    ['2026-10-24T21:00:00Z','2026-10-25T22:00:00Z',25],
  ])('uses calendar midnight across DST: %s', (start,end,hours) => {
    const timestamp=Date.parse(start as string)
    expect(endOfAccessDay(timestamp)).toBe(Date.parse(end as string))
    expect(endOfAccessDay(timestamp)-timestamp).toBe(Number(hours)*3600000)
    expect(localAccessDay(endOfAccessDay(timestamp)-1)).toBe(localAccessDay(timestamp))
    expect(localAccessDay(endOfAccessDay(timestamp))).not.toBe(localAccessDay(timestamp))
  })
  it.each(['password_hash','role','phone','tenant_id','id'] as const)('revokes when %s changes', key => {
    open().remember(user); user[key]='changed'
    expect(open().restore()).toBeNull(); expect(stored).toBeNull()
  })
  it('PIN changes do not affect password-only access', () => {
    open().remember(user); user.pin_hash='irrelevant-legacy-value'
    expect(open().restore()?.id).toBe(user.id)
  })
  it.each(['inactive','deleted','clock','missing','tire_worker','empty-password'])('fails closed for %s', reason => {
    open().remember(user)
    if(reason==='inactive') user.is_active=0
    if(reason==='deleted') user.deleted_at='now'
    if(reason==='clock') now--
    if(reason==='missing') missing=true
    if(reason==='tire_worker') user.role='tire_worker'
    if(reason==='empty-password') user.password_hash=''
    expect(open().restore()).toBeNull()
  })
  it.each(['version','expiry','day','fingerprint','garbage'])('rejects invalid stored %s', reason => {
    open().remember(user)
    const value=JSON.parse(Buffer.from(stored!,'base64').toString())
    if(reason==='version') value.version=1
    if(reason==='expiry') value.expires+=86400000
    if(reason==='day') value.day='2099-01-01'
    if(reason==='fingerprint') value.fingerprint='wrong'
    stored=Buffer.from(reason==='garbage'?'invalid':JSON.stringify(value)).toString('base64')
    expect(open().restore()).toBeNull(); expect(stored).toBeNull()
  })
  it('full logout removes access across restarts', () => {
    open().remember(user); open().forget()
    expect(stored).toBeNull(); expect(open().restore()).toBeNull()
  })
  it('never saves plaintext if Windows encryption fails', () => {
    const access=new RememberedAccess({read:()=>null,write:value=>{stored=value},encrypt:()=>{throw Error('Windows unavailable')},decrypt:x=>x,user:()=>user})
    expect(()=>access.remember(user)).toThrow('Windows unavailable')
    expect(stored).toBeNull()
  })
  it('exposes only validated restore, not save or PIN bypass endpoints', () => {
    expect(PUBLIC_DESKTOP_CHANNELS.has('desktop:auth:restore')).toBe(true)
    for(const name of ['remember','set-pin-required','unlock-remembered']) {
      expect(PUBLIC_DESKTOP_CHANNELS.has('desktop:auth:'+name)).toBe(false)
      expect(isDesktopChannelAllowed('desktop:auth:'+name,'cashier')).toBe(false)
      expect(isDesktopChannelAllowed('desktop:auth:'+name,'owner')).toBe(false)
    }
  })
})
