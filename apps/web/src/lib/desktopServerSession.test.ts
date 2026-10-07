import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import type {Session} from '@supabase/supabase-js'
const fixture=vi.hoisted(()=>({desktop:true,status:vi.fn(),restore:vi.fn(),save:vi.fn(),create:vi.fn(),verify:vi.fn(),attach:vi.fn(),report:vi.fn()}))
vi.mock('@supabase/supabase-js',()=>({createClient:fixture.create}))
vi.mock('./desktopBridge',()=>({isDesktopRuntime:()=>fixture.desktop,desktopBridge:()=>({auth:{rememberedStatus:fixture.status,restoreServerSession:fixture.restore,saveServerSession:fixture.save}})}))
vi.mock('./supabase',()=>({supabase:{auth:{setSession:fixture.attach}}}))
vi.mock('./localDiagnostics',()=>({reportLocalError:fixture.report}))
import {restoreDesktopServerSession,rememberDesktopServerSession} from './desktopServerSession'
const local=()=>({user:{id:'cashier',app_metadata:{tenant_id:'shop',role:'cashier'}},access_token:'local-desktop-cashier',refresh_token:'local'}) as Session
const remote=()=>({...local(),access_token:'new.access.token',refresh_token:'new-refresh'}) as Session
beforeEach(()=>{
  vi.resetAllMocks();fixture.desktop=true;vi.stubGlobal('navigator',{onLine:true})
  vi.stubEnv('VITE_SUPABASE_URL','https://fixture.supabase.co');vi.stubEnv('VITE_SUPABASE_ANON_KEY','public')
  fixture.restore.mockResolvedValue({access_token:'old.access.token',refresh_token:'old-refresh'})
  fixture.create.mockReturnValue({auth:{setSession:fixture.verify}})
  fixture.verify.mockResolvedValue({data:{session:remote()},error:null})
  fixture.attach.mockResolvedValue({data:{session:remote()},error:null})
  fixture.save.mockResolvedValue({success:true})
  fixture.status.mockResolvedValue({available:true,locked:false})
})
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.useRealTimers()})
describe('automatic protected cloud session after local day restore',()=>{
  it('restores without password and saves rotated tokens before attaching the same cashier',async()=>{
    const result=await restoreDesktopServerSession(local(),()=>true)
    expect(result?.user.id).toBe('cashier')
    expect(fixture.verify).toHaveBeenCalledWith({access_token:'old.access.token',refresh_token:'old-refresh'})
    expect(fixture.create.mock.calls[0][2].auth.persistSession).toBe(false)
    expect(fixture.save).toHaveBeenCalledWith({access_token:'new.access.token',refresh_token:'new-refresh'})
    expect(fixture.save.mock.invocationCallOrder[0]).toBeLessThan(fixture.attach.mock.invocationCallOrder[0])
  })
  it('coalesces simultaneous status and startup restoration',async()=>{
    const who=local()
    const a=restoreDesktopServerSession(who,()=>true),b=restoreDesktopServerSession(who,()=>true)
    expect(a).toBe(b);await a
    expect(fixture.restore).toHaveBeenCalledOnce();expect(fixture.verify).toHaveBeenCalledOnce()
  })
  it.each(['web','offline','no-tenant','no-user'])('does not access the cache for %s',async reason=>{
    const who=local()
    if(reason==='web') fixture.desktop=false
    if(reason==='offline') vi.stubGlobal('navigator',{onLine:false})
    if(reason==='no-tenant') delete who.user.app_metadata.tenant_id
    if(reason==='no-user') who.user.id=''
    expect(await restoreDesktopServerSession(who,()=>true)).toBeNull()
    expect(fixture.restore).not.toHaveBeenCalled()
  })
  it('does not invent credentials for an old cache with no server session',async()=>{
    fixture.restore.mockResolvedValue(null)
    expect(await restoreDesktopServerSession(local(),()=>true)).toBeNull()
    expect(fixture.verify).not.toHaveBeenCalled();expect(fixture.attach).not.toHaveBeenCalled()
  })
  it.each(['other-user','other-shop','disabled','deleted','tire-worker','invalid-refresh'])('rejects %s without changing the global identity',async reason=>{
    const session=remote()
    if(reason==='other-user') session.user.id='other'
    if(reason==='other-shop') session.user.app_metadata.tenant_id='other'
    if(reason==='disabled') session.user.app_metadata.can_login=false
    if(reason==='deleted') session.user.app_metadata.deleted_at='now'
    if(reason==='tire-worker') session.user.app_metadata.role='tire_worker'
    fixture.verify.mockResolvedValue({data:{session},error:reason==='invalid-refresh'?Error('private credential'):null})
    expect(await restoreDesktopServerSession(local(),()=>true)).toBeNull()
    expect(fixture.attach).not.toHaveBeenCalled();expect(fixture.save).not.toHaveBeenCalled()
  })
  it('ignores a reply after logout/account switch',async()=>{
    let done!:(value:any)=>void,current=true
    fixture.verify.mockImplementation(()=>new Promise(r=>{done=r}))
    const pending=restoreDesktopServerSession(local(),()=>current)
    await vi.waitFor(()=>expect(done).toBeTypeOf('function'))
    current=false;done({data:{session:remote()},error:null})
    expect(await pending).toBeNull();expect(fixture.attach).not.toHaveBeenCalled();expect(fixture.save).not.toHaveBeenCalled()
  })
  it('keeps local access when the cache is unavailable and emits no raw token in diagnostics',async()=>{
    fixture.save.mockRejectedValue(Error('new-refresh secret'))
    expect((await restoreDesktopServerSession(local(),()=>true))?.user.id).toBe('cashier')
    expect(fixture.report).toHaveBeenCalled()
    expect(fixture.report.mock.calls[0][0].message).toBe('AI_SERVER_SESSION_CACHE_FAILED')
  })
  it('does not send background cache writes after the day permission has expired',async()=>{
    fixture.status.mockResolvedValue({available:false,locked:true})
    for(let hour=0;hour<6;hour++) await rememberDesktopServerSession({...remote(),access_token:`hour${hour}.payload.signature`})
    expect(fixture.save).not.toHaveBeenCalled()
    expect(fixture.report).not.toHaveBeenCalled()
  })
  it('does not reattach a server session when the local day ended during verification',async()=>{
    fixture.save.mockResolvedValue({success:false,reason:'local-session-ended'})
    expect(await restoreDesktopServerSession(local(),()=>true)).toBeNull()
    expect(fixture.attach).not.toHaveBeenCalled();expect(fixture.report).not.toHaveBeenCalled()
  })
  it('resumes caching after a fresh password login on the next day',async()=>{
    fixture.status.mockResolvedValueOnce({available:false,locked:true})
    await expect(rememberDesktopServerSession(remote())).resolves.toEqual({success:false,reason:'local-session-ended'})
    await expect(rememberDesktopServerSession(remote())).resolves.toEqual({success:true})
    expect(fixture.save).toHaveBeenCalledOnce()
  })
  it('coalesces duplicate refresh events and does not call Auth twice',async()=>{
    let finish!:(value:any)=>void
    fixture.status.mockReturnValue(new Promise(resolve=>{finish=resolve}))
    const first=rememberDesktopServerSession(remote()),second=rememberDesktopServerSession(remote())
    await vi.waitFor(()=>expect(finish).toBeTypeOf('function'))
    finish({available:true,locked:false})
    await Promise.all([first,second])
    expect(fixture.status).toHaveBeenCalledOnce();expect(fixture.save).toHaveBeenCalledOnce()
  })
  it('does not send stale credentials after logout during the preflight check',async()=>{
    let finish!:(value:any)=>void,current=true
    fixture.status.mockReturnValue(new Promise(resolve=>{finish=resolve}))
    const pending=rememberDesktopServerSession(remote(),()=>current)
    await vi.waitFor(()=>expect(finish).toBeTypeOf('function'))
    current=false;finish({available:true,locked:false})
    await expect(pending).resolves.toEqual({success:false,reason:'superseded'})
    expect(fixture.save).not.toHaveBeenCalled();expect(fixture.report).not.toHaveBeenCalled()
  })
  it('a superseded call cannot swallow or clear the next login cache flight',async()=>{
    const replies:Array<(value:any)=>void>=[]
    fixture.status.mockImplementation(()=>new Promise(resolve=>replies.push(resolve)))
    let old=true
    const first=rememberDesktopServerSession(remote(),()=>old)
    await vi.waitFor(()=>expect(replies).toHaveLength(1));old=false
    const second=rememberDesktopServerSession(remote(),()=>true)
    await vi.waitFor(()=>expect(replies).toHaveLength(2))
    replies[0]({available:true,locked:false});await first
    const duplicate=rememberDesktopServerSession(remote(),()=>true)
    replies[1]({available:true,locked:false})
    await Promise.all([second,duplicate])
    expect(fixture.status).toHaveBeenCalledTimes(2);expect(fixture.save).toHaveBeenCalledOnce()
  })
  it('reports real status failures without including credentials and without writing the cache',async()=>{
    fixture.status.mockRejectedValue(Error('private-refresh-secret'))
    await expect(rememberDesktopServerSession(remote())).resolves.toBeNull()
    expect(fixture.save).not.toHaveBeenCalled()
    expect(fixture.report.mock.calls[0][0].message).toBe('AI_SERVER_SESSION_CACHE_FAILED')
  })
  it('bounds an unresponsive status request and ignores its late reply',async()=>{
    vi.useFakeTimers();let finish!:(value:any)=>void
    fixture.status.mockReturnValue(new Promise(resolve=>{finish=resolve}))
    const pending=rememberDesktopServerSession(remote())
    await vi.advanceTimersByTimeAsync(5001)
    await expect(pending).resolves.toBeNull()
    finish({available:true,locked:false});await Promise.resolve()
    expect(fixture.save).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0)
  })
  it('returns no restored session if logout happened while global attachment completed',async()=>{
    let finish!:(value:any)=>void,current=true
    fixture.attach.mockReturnValue(new Promise(resolve=>{finish=resolve}))
    const pending=restoreDesktopServerSession(local(),()=>current)
    await vi.waitFor(()=>expect(fixture.attach).toHaveBeenCalledOnce())
    current=false;finish({data:{session:remote()},error:null})
    expect(await pending).toBeNull()
  })
  it('never stores a synthetic offline token',async()=>{
    await rememberDesktopServerSession(local());expect(fixture.save).not.toHaveBeenCalled()
  })
  it('times out a stalled provider while the local day session remains independent',async()=>{
    vi.useFakeTimers();fixture.verify.mockReturnValue(new Promise(()=>{}))
    const pending=restoreDesktopServerSession(local(),()=>true)
    await vi.advanceTimersByTimeAsync(15001);expect(await pending).toBeNull()
    expect(fixture.attach).not.toHaveBeenCalled();expect(fixture.save).not.toHaveBeenCalled()
  })
})
