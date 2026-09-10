import { describe, it, expect, beforeEach } from 'vitest'
import { RememberedAccess, type RememberedUser } from '../src/security/rememberedAccess'
import { hashSecret } from '../src/security/secretHash'
import { isDesktopChannelAllowed, PUBLIC_DESKTOP_CHANNELS } from '../src/security/desktopAuthorization'

describe('remembered local access', () => {
  let stored: string | null, now: number, user: RememberedUser, pinRequired: boolean
  const passwordHash = hashSecret('test-only-password')
  const pinHash = hashSecret('5281')
  function open() {
    return new RememberedAccess({
      read: () => stored, write: value => { stored = value }, now: () => now,
      pinRequired: () => pinRequired,
      encrypt: text => Buffer.from(text).toString('base64'),
      decrypt: text => Buffer.from(text,'base64').toString(),
      user: (id,tenant) => id===user.id && tenant===user.tenant_id ? user : null,
    })
  }
  beforeEach(() => {
    stored=null; now=1000000; pinRequired=true
    user={id:'cashier',tenant_id:'store',role:'cashier',phone:'+380000000000',full_name:'Test',password_hash:passwordHash,pin_hash:pinHash,is_active:1,deleted_at:null}
  })
  it('requires PIN after restart and returns no credential hashes', () => {
    const first=open(); first.remember(user)
    expect(first.status()?.locked).toBe(false)
    const restarted=open()
    expect(restarted.status()?.locked).toBe(true)
    expect(restarted.unlock('5281')).not.toHaveProperty('password_hash')
    expect(restarted.status()?.locked).toBe(false)
    expect(Buffer.from(stored!,'base64').toString()).not.toContain(pinHash)
    expect(Buffer.from(stored!,'base64').toString()).not.toContain(passwordHash)
  })
  it('expires after 24 hours and PIN does not extend expiry', () => {
    const access=open(); access.remember(user)
    now+=23*3600000; access.unlock('5281')
    now+=3600000
    expect(access.status()).toBeNull()
    expect(stored).toBeNull()
    expect(() => access.unlock('5281')).toThrow()
  })
  it('preserves failed attempts across restarts and revokes at five', () => {
    open().remember(user)
    for(let i=0;i<5;i++) expect(() => open().unlock('0000')).toThrow()
    expect(stored).toBeNull()
    expect(() => open().unlock('5281')).toThrow()
  })
  it.each(['password_hash','pin_hash','role','phone'] as const)('revokes when %s changes', key => {
    open().remember(user); user[key]='changed'
    expect(open().status()).toBeNull()
  })
  it.each(['inactive','deleted','clock'])('fails closed for %s', reason => {
    open().remember(user)
    if(reason==='inactive') user.is_active=0
    if(reason==='deleted') user.deleted_at='now'
    if(reason==='clock') now--
    expect(open().status()).toBeNull()
  })
  it('explicit logout deletes remembered permission', () => {
    const access=open(); access.remember(user); access.forget()
    expect(stored).toBeNull(); expect(open().status()).toBeNull()
  })
  it('allows remembered access without PIN only when disabled, but still expires', () => {
    pinRequired=false; user.pin_hash=''
    open().remember(user)
    const restarted=open(); restarted.lock()
    expect(restarted.status()?.locked).toBe(false)
    expect(restarted.unlock('').id).toBe(user.id)
    now+=24*3600000
    expect(() => restarted.unlock('')).toThrow()
  })
  it('requires PIN again after re-enabling and preserves logout revocation', () => {
    pinRequired=false; open().remember(user)
    pinRequired=true
    expect(open().status()?.locked).toBe(true)
    expect(() => open().unlock('')).toThrow()
    expect(open().unlock('5281').id).toBe(user.id)
    open().forget(); pinRequired=false
    expect(() => open().unlock('')).toThrow()
  })
  it('allows only administrators to change the PIN policy', () => {
    expect(PUBLIC_DESKTOP_CHANNELS.has('desktop:auth:set-pin-required')).toBe(false)
    expect(isDesktopChannelAllowed('desktop:auth:set-pin-required','cashier')).toBe(false)
    expect(isDesktopChannelAllowed('desktop:auth:set-pin-required','owner')).toBe(true)
  })
  it('refuses saving if secure storage fails', () => {
    const access=new RememberedAccess({read:()=>null,write:()=>{throw Error('write')},encrypt:()=>{throw Error('Windows unavailable')},decrypt:x=>x,user:()=>user})
    expect(()=>access.remember(user)).toThrow('Windows unavailable')
  })
  it('does not expose remember as unauthenticated IPC', () => {
    expect(PUBLIC_DESKTOP_CHANNELS.has('desktop:auth:remember')).toBe(false)
    expect(isDesktopChannelAllowed('desktop:auth:remember','cashier')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:auth:remember','unknown')).toBe(false)
  })
})
