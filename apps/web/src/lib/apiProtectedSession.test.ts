import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest'
const fixture=vi.hoisted(()=>({local:null as any,online:null as any,restore:vi.fn()}))
vi.mock('./desktopBridge',()=>({isDesktopRuntime:()=>true}))
vi.mock('./supabase',()=>({supabase:{auth:{getSession:async()=>({data:{session:fixture.online}}),refreshSession:async()=>({data:{session:null}})}}}))
vi.mock('./desktopServerSession',()=>({restoreDesktopServerSession:fixture.restore}))
vi.mock('@/stores/authStore',()=>({useAuthStore:{getState:()=>({session:fixture.local})}}))
import {request} from './api'
const session=(id='cashier',tenant='shop')=>({user:{id,app_metadata:{tenant_id:tenant}},access_token:'verified-cloud-token'})
beforeEach(()=>{
  vi.resetAllMocks();fixture.local={...session(),access_token:'local-desktop-cashier'};fixture.online=null
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"data":{"enabled":true}}',{status:200})))
})
afterEach(()=>vi.unstubAllGlobals())
describe('AI status automatically restores protected online access',()=>{
  it('uses the restored real token for the first request after restarting',async()=>{
    fixture.restore.mockImplementation(async(_local,current)=>{expect(current()).toBe(true);fixture.online=session();return fixture.online})
    await request('/api/v1/ai/status',{silent:true})
    expect(fixture.restore).toHaveBeenCalledOnce()
    expect((fetch as any).mock.calls[0][1].headers.Authorization).toBe('Bearer verified-cloud-token')
  })
  it('never sends another employee token after an account switch',async()=>{
    fixture.restore.mockImplementation(async(_local,current)=>{fixture.local=session('new');expect(current()).toBe(false);fixture.online=session('cashier');return fixture.online})
    await request('/api/v1/ai/status',{silent:true})
    expect((fetch as any).mock.calls[0][1].headers).not.toHaveProperty('Authorization')
  })
  it('does not try recovery when a matching online session already exists',async()=>{
    fixture.online=session();await request('/api/v1/ai/status',{silent:true})
    expect(fixture.restore).not.toHaveBeenCalled()
  })
})
