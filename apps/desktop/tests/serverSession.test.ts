import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { checkedServerTokens, verifyAndRememberServerSession } from '../src/security/serverSession'
import { isLanProxyChannel } from '../src/lan/localNetwork'
import { DesktopSessionLifecycleError, serverSessionCacheResultForError } from '../src/security/desktopSessionLifecycle'
const tokens={access_token:'header.payload.signature',refresh_token:'refresh-secret'}
const user=()=>({id:'cashier',app_metadata:{tenant_id:'shop',role:'cashier'}})
let identity:{id:string;tenant_id:string;generation:number}
const fetcher=vi.fn(),save=vi.fn()
const deps=()=>({current:()=>identity,fetch:fetcher,save,config:{supabaseUrl:'https://fixture.supabase.co',supabaseAnonKey:'public-key'}})
beforeEach(()=>{vi.resetAllMocks();identity={id:'cashier',tenant_id:'shop',generation:1};fetcher.mockResolvedValue(new Response(JSON.stringify(user()),{status:200}))})
afterEach(()=>vi.useRealTimers())
describe('encrypted server session verification',()=>{
  it('validates against the fixed auth server and saves only whitelisted tokens',async()=>{
    await expect(verifyAndRememberServerSession({...tokens,password:'never-save'},deps())).resolves.toEqual({success:true})
    expect(fetcher.mock.calls[0][0]).toBe('https://fixture.supabase.co/auth/v1/user')
    expect(save).toHaveBeenCalledWith(identity,tokens)
    expect(isLanProxyChannel('desktop:auth:restore-server-session')).toBe(false)
    expect(isLanProxyChannel('desktop:auth:save-server-session')).toBe(false)
  })
  it.each([null,{}, {access_token:'local-desktop-x',refresh_token:'x'}, {...tokens,refresh_token:'bad token'}, {...tokens,access_token:'a'.repeat(40000)}])('rejects malformed credentials before network %j',async input=>{
    await expect(verifyAndRememberServerSession(input,deps())).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled()
  })
  it.each(['other-user','other-shop','inactive','disabled','deleted','tire-worker'])('rejects %s returned by Auth',async reason=>{
    const remote=user()
    if(reason==='other-user') remote.id='other'
    if(reason==='other-shop') remote.app_metadata.tenant_id='other'
    if(reason==='inactive') Object.assign(remote.app_metadata,{is_active:false})
    if(reason==='disabled') Object.assign(remote.app_metadata,{can_login:false})
    if(reason==='deleted') Object.assign(remote.app_metadata,{deleted_at:'now'})
    if(reason==='tire-worker') remote.app_metadata.role='tire_worker'
    fetcher.mockResolvedValue(new Response(JSON.stringify(remote),{status:200}))
    await expect(verifyAndRememberServerSession(tokens,deps())).rejects.toThrow('Не вдалося')
    expect(save).not.toHaveBeenCalled()
  })
  it.each(['logout','same-user-new-login','newer-token'])('discards a delayed save after %s',async reason=>{
    let finish!:(r:Response)=>void;fetcher.mockReturnValue(new Promise(r=>{finish=r}))
    const pending=verifyAndRememberServerSession(tokens,deps())
    identity={...identity,generation:2}
    if(reason==='logout') identity.id=''
    finish(new Response(JSON.stringify(user()),{status:200}))
    await expect(pending).resolves.toEqual({success:false,reason:'superseded'});expect(save).not.toHaveBeenCalled()
  })
  it.each([401,403,500])('does not store or expose a provider error %s',async status=>{
    fetcher.mockResolvedValue(new Response('private-refresh-secret',{status}))
    await expect(verifyAndRememberServerSession(tokens,deps())).rejects.toThrow('Не вдалося')
    expect(save).not.toHaveBeenCalled()
  })
  it('aborts a stalled verification without logging token material',async()=>{
    vi.useFakeTimers()
    fetcher.mockImplementation((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error(tokens.refresh_token)))))
    const rejected=expect(verifyAndRememberServerSession(tokens,deps())).rejects.toThrow('Не вдалося')
    await vi.advanceTimersByTimeAsync(10001);await rejected;expect(save).not.toHaveBeenCalled()
  })
  it.each(['local-session-ended','superseded'] as const)('skips %s before contacting Auth',async reason=>{
    const options={...deps(),current:()=>{throw new DesktopSessionLifecycleError(reason,'Local session changed')}}
    await expect(verifyAndRememberServerSession(tokens,options)).resolves.toEqual({success:false,reason})
    expect(fetcher).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled()
  })
  it.each(['local-session-ended','superseded'] as const)('skips %s during Auth verification without saving',async reason=>{
    let finish!:(value:Response)=>void
    fetcher.mockReturnValue(new Promise(resolve=>{finish=resolve}))
    const current=vi.fn().mockReturnValueOnce(identity).mockImplementation(()=>{throw new DesktopSessionLifecycleError(reason,'Local session changed')})
    const pending=verifyAndRememberServerSession(tokens,{...deps(),current})
    finish(new Response(JSON.stringify(user()),{status:200}))
    await expect(pending).resolves.toEqual({success:false,reason});expect(save).not.toHaveBeenCalled()
  })
  it('does not mistake storage failures for an expected session end',async()=>{
    save.mockImplementation(()=>{throw Error('disk failure with private credential')})
    await expect(verifyAndRememberServerSession(tokens,deps())).rejects.toThrow('Не вдалося захищено')
  })
  it('late older verification cannot overwrite a newer refresh',async()=>{
    const replies:Array<(value:Response)=>void>=[]
    fetcher.mockImplementation(()=>new Promise(resolve=>replies.push(resolve)))
    let latest=1
    const first=verifyAndRememberServerSession(tokens,{...deps(),current:()=>{
      if(latest!==1) throw new DesktopSessionLifecycleError('superseded','Newer refresh')
      return identity
    }})
    latest=2
    const nextTokens={access_token:'new.payload.signature',refresh_token:'new-refresh'}
    const second=verifyAndRememberServerSession(nextTokens,deps())
    replies[1](new Response(JSON.stringify(user()),{status:200}))
    await expect(second).resolves.toEqual({success:true})
    replies[0](new Response(JSON.stringify(user()),{status:200}))
    await expect(first).resolves.toEqual({success:false,reason:'superseded'})
    expect(save).toHaveBeenCalledOnce();expect(save).toHaveBeenCalledWith(identity,nextTokens)
  })
  it('only optional cache endpoints treat session end as an empty result',()=>{
    const ended=new DesktopSessionLifecycleError('local-session-ended','End of day')
    expect(serverSessionCacheResultForError('desktop:auth:save-server-session',ended)).toEqual({success:false,reason:'local-session-ended'})
    expect(serverSessionCacheResultForError('desktop:auth:restore-server-session',ended)).toBeNull()
    for(const channel of ['desktop:auth:login','desktop:pos:checkout','desktop:supply:post-invoice','desktop:catalog:save-product']) {
      expect(serverSessionCacheResultForError(channel,ended)).toBeUndefined()
    }
    expect(serverSessionCacheResultForError('desktop:auth:save-server-session',Error('Збережений вхід завершено'))).toBeUndefined()
    expect(serverSessionCacheResultForError('desktop:auth:save-server-session',Error('disk failure'))).toBeUndefined()
  })
  it('copies token fields rather than retaining caller object',()=>{
    const result=checkedServerTokens(tokens);expect(result).toEqual(tokens);expect(result).not.toBe(tokens)
  })
})
