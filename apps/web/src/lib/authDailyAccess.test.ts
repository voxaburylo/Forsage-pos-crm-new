import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
const fixture = vi.hoisted(() => ({
  restore:vi.fn(),logout:vi.fn(),login:vi.fn(),loginOnline:vi.fn(),getSession:vi.fn(),remoteOut:vi.fn(),
  remoteLogin:vi.fn(),attach:vi.fn(),setOfflineSession:vi.fn(),setSession:vi.fn(),session:null as any,desktop:true,
}))
vi.mock('./supabase',()=>({supabase:{auth:{getSession:fixture.getSession,signOut:fixture.remoteOut,signInWithPassword:fixture.remoteLogin,setSession:fixture.attach}}}))
vi.mock('./desktopBridge',()=>({isDesktopRuntime:()=>fixture.desktop,desktopBridge:()=>fixture.desktop?{auth:{restore:fixture.restore,logout:fixture.logout,login:fixture.login,loginOnline:fixture.loginOnline}}:undefined}))
vi.mock('@/stores/authStore',()=>({useAuthStore:{getState:()=>({session:fixture.session,setOfflineSession:fixture.setOfflineSession,setSession:fixture.setSession})}}))
const user={id:'cashier',tenant_id:'shop',role:'cashier',phone:'+380671111111',email:'380671111111@forsage.internal',full_name:'Test'}
function deferred<T>() { let resolve!:(value:T)=>void; let reject!:(error:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject} }
beforeEach(()=>{
  vi.resetModules();vi.resetAllMocks();vi.useFakeTimers();fixture.session=null;fixture.desktop=true
  vi.stubGlobal('navigator',{onLine:true})
  fixture.restore.mockResolvedValue(user);fixture.logout.mockResolvedValue(undefined)
  fixture.getSession.mockResolvedValue({data:{session:null}});fixture.remoteOut.mockResolvedValue({error:null})
  fixture.login.mockResolvedValue(user);fixture.remoteLogin.mockResolvedValue({data:{session:null},error:{message:'Invalid login credentials'}})
  fixture.setOfflineSession.mockImplementation(session=>{fixture.session=session})
  fixture.setSession.mockImplementation(session=>{fixture.session=session})
})
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals()})
describe('daily desktop sign-in lifecycle',()=>{
  it('coalesces concurrent restores and opens local access without waiting for internet',async()=>{
    const auth=await import('./auth');const wait=deferred<typeof user>();fixture.restore.mockReturnValue(wait.promise)
    fixture.getSession.mockReturnValue(new Promise(()=>{}))
    const one=auth.restoreDesktopSession(),two=auth.restoreDesktopSession()
    expect(one).toBe(two);expect(fixture.restore).toHaveBeenCalledOnce()
    wait.resolve(user);expect((await one)?.user.id).toBe(user.id)
    expect(fixture.setOfflineSession).toHaveBeenCalledOnce();expect(fixture.remoteLogin).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('missing or expired permission leaves the password form',async()=>{
    const auth=await import('./auth');fixture.restore.mockResolvedValue(null)
    expect(await auth.restoreDesktopSession()).toBeNull();expect(fixture.setOfflineSession).not.toHaveBeenCalled()
  })
  it('does not resurrect a user from a late restore after full logout',async()=>{
    const auth=await import('./auth');const wait=deferred<typeof user>();fixture.restore.mockReturnValue(wait.promise)
    const pending=auth.restoreDesktopSession();await auth.signOut();wait.resolve(user)
    expect(await pending).toBeNull();expect(fixture.session).toBeNull();expect(fixture.setOfflineSession).not.toHaveBeenCalled()
  })
  it('times out a stuck restore and ignores the late reply',async()=>{
    const auth=await import('./auth');const wait=deferred<typeof user>();fixture.restore.mockReturnValue(wait.promise)
    const rejected=expect(auth.restoreDesktopSession()).rejects.toThrow('RESTORE_TIMEOUT')
    await vi.advanceTimersByTimeAsync(5001);await rejected
    wait.resolve(user);await Promise.resolve();expect(fixture.setOfflineSession).not.toHaveBeenCalled()
  })
  it('full exit revokes local access first and works with a stuck server',async()=>{
    const auth=await import('./auth');await auth.restoreDesktopSession()
    fixture.remoteOut.mockReturnValue(new Promise(()=>{}))
    const pending=auth.signOut();await Promise.resolve()
    expect(fixture.logout).toHaveBeenCalledOnce();expect(fixture.session).toBeNull()
    await vi.advanceTimersByTimeAsync(2001);await pending
    expect(fixture.remoteOut).toHaveBeenCalledWith({scope:'local'});expect(vi.getTimerCount()).toBe(0)
  })
  it('does not claim successful logout if local revocation fails',async()=>{
    const auth=await import('./auth');await auth.restoreDesktopSession()
    fixture.logout.mockRejectedValue(Error('disk error'))
    await expect(auth.signOut()).rejects.toThrow('disk error')
    expect(fixture.session?.user.id).toBe(user.id);expect(fixture.remoteOut).not.toHaveBeenCalled()
  })
  it('late password login after logout cannot restore access or retry online',async()=>{
    const auth=await import('./auth');const wait=deferred<typeof user>();fixture.login.mockReturnValue(wait.promise)
    const rejected=expect(auth.signIn(user.phone,'test-password')).rejects.toThrow('скасовано')
    await auth.signOut();wait.resolve(user);await rejected
    expect(fixture.session).toBeNull();expect(fixture.loginOnline).not.toHaveBeenCalled()
  })
  it('cancels background server retries on full exit',async()=>{
    const auth=await import('./auth');vi.stubGlobal('navigator',{onLine:false})
    await auth.signIn(user.phone,'test-password');expect(vi.getTimerCount()).toBe(1)
    await auth.signOut();expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(3600000);expect(fixture.remoteLogin).not.toHaveBeenCalled()
  })
  it('a rejected old server request cannot schedule retry after logout',async()=>{
    const auth=await import('./auth');const wait=deferred<any>();fixture.remoteLogin.mockReturnValue(wait.promise)
    await auth.signIn(user.phone,'test-password');await auth.signOut()
    wait.reject(Error('offline'));await Promise.resolve();await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0);expect(fixture.session).toBeNull()
  })
  it('does not attempt desktop restore in the browser',async()=>{
    const auth=await import('./auth');fixture.desktop=false
    expect(await auth.restoreDesktopSession()).toBeNull();expect(fixture.restore).not.toHaveBeenCalled()
  })
})
