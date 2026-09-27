import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@supabase/supabase-js'
const hook=vi.hoisted(()=>({callback:null as null | ((event:string,session:Session|null)=>void)}))
vi.mock('@/lib/supabase',()=>({supabase:{auth:{onAuthStateChange:(callback:typeof hook.callback)=>{hook.callback=callback},refreshSession:vi.fn()}}}))
vi.mock('@/lib/desktopBridge',()=>({isDesktopRuntime:()=>true}))
import { useAuthStore } from './authStore'
const session=(id:string,role='cashier')=>({user:{id,app_metadata:{role,tenant_id:'shop'}},access_token:id,refresh_token:id}) as Session
describe('server events cannot replace verified local identity',()=>{
  beforeEach(()=>useAuthStore.getState().setSession(null))
  it('ignores old owner login after switching to cashier',()=>{
    useAuthStore.getState().setOfflineSession(session('cashier'))
    hook.callback!('SIGNED_IN',session('owner','owner'))
    expect(useAuthStore.getState().session?.user.id).toBe('cashier')
    useAuthStore.getState().setSession(session('owner','owner'))
    expect(useAuthStore.getState().session?.user.id).toBe('cashier')
  })
  it('attaches matching server token but preserves verified local role',()=>{
    useAuthStore.getState().setOfflineSession(session('cashier'))
    hook.callback!('SIGNED_IN',session('cashier','owner'))
    expect(useAuthStore.getState().offlineMode).toBe(false)
    expect(useAuthStore.getState().session?.user.app_metadata.role).toBe('cashier')
  })
  it('server disconnect after successful reconnect does not close the local till',()=>{
    useAuthStore.getState().setOfflineSession(session('cashier'))
    hook.callback!('SIGNED_IN',session('cashier'))
    hook.callback!('SIGNED_OUT',null)
    expect(useAuthStore.getState().session?.user.id).toBe('cashier')
    expect(useAuthStore.getState().offlineMode).toBe(true)
  })
  it('explicit logout still clears the local session',()=>{
    useAuthStore.getState().setOfflineSession(session('cashier'))
    useAuthStore.getState().setSession(null)
    hook.callback!('SIGNED_OUT',null)
    expect(useAuthStore.getState().session).toBeNull()
    hook.callback!('SIGNED_IN',session('cashier'))
    expect(useAuthStore.getState().session).toBeNull()
  })
  it('does not attach a token from another shop to the verified local account',()=>{
    useAuthStore.getState().setOfflineSession(session('cashier'))
    const remote=session('cashier');remote.user.app_metadata.tenant_id='different-shop'
    hook.callback!('SIGNED_IN',remote)
    expect(useAuthStore.getState().session?.user.app_metadata.tenant_id).toBe('shop')
    expect(useAuthStore.getState().offlineMode).toBe(true)
  })
})
