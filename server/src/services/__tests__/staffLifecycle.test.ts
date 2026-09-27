import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(()=>({users:new Map<string,any>(),hardDelete:vi.fn(),fail:false}))
vi.mock('../../db/supabaseAdmin.js',()=>({supabaseAdmin:{auth:{admin:{
  listUsers:async()=>({data:{users:[...state.users.values()]},error:null}),
  getUserById:async(id:string)=>({data:{user:state.users.get(id)},error:null}),
  updateUserById:async(id:string,input:any)=>{
    if(state.fail)return{data:{user:null},error:{message:'simulated offline'}}
    const user={...state.users.get(id),...input};state.users.set(id,user);return{data:{user},error:null}
  },
  createUser:vi.fn(),deleteUser:state.hardDelete,
}}}}))
vi.mock('../../db/supabase.js',()=>({db:{from:vi.fn(()=>{throw Error('No business history should be modified')})}}))
vi.mock('../../db/pg.js',()=>({pool:{},runTransaction:vi.fn()}))
vi.mock('../productService.js',()=>({clearProductSearchCache:vi.fn()}))
vi.mock('../syncGeneration.js',()=>({beginTenantReset:vi.fn(),clearTenantResetMarker:vi.fn()}))
import { createUser,deactivateUser,deleteUser,listUsers,restoreUser,updateUser } from '../adminService.js'
import { applyStaffUserDeleted,applyStaffUserUpsert } from '../sync/staffHandlers.js'
const tenant='00000000-0000-0000-0000-000000000001',id='11111111-1111-4111-8111-111111111111'
const profile=()=>({id,email:'380671112233@forsage.internal',user_metadata:{phone:'+380671112233',full_name:'Тест'},app_metadata:{tenant_id:tenant,role:'cashier',is_active:true,can_login:true},created_at:'2026-09-16T00:00:00Z'})
describe('server employee archive and mirror lifecycle',()=>{
  beforeEach(()=>{state.users.clear();state.users.set(id,profile());state.hardDelete.mockClear();state.fail=false})
  it('archives and restores the same identity without deleting business references',async()=>{
    await deleteUser(id,tenant)
    expect(await listUsers(tenant)).toEqual([])
    expect((await listUsers(tenant,true))[0].deleted_at).toBeTruthy()
    await restoreUser(id,tenant)
    expect((await listUsers(tenant))[0]).toMatchObject({id,is_active:true,deleted_at:null})
    expect(state.hardDelete).not.toHaveBeenCalled()
  })
  it('offers archive recovery for duplicate phones, including local format',async()=>{
    await deleteUser(id,tenant)
    await expect(createUser({phone:'0671112233',full_name:'Тест',role:'cashier',password:'test-password'},tenant)).rejects.toThrow('Відновіть')
  })
  it('rejects restoring another tenant and leaves the archive intact on network failure',async()=>{
    await deleteUser(id,tenant)
    await expect(restoreUser(id,'another-shop')).rejects.toThrow('не знайдено')
    state.fail=true;await expect(restoreUser(id,tenant)).rejects.toThrow('simulated')
    expect(state.users.get(id).app_metadata.is_active).toBe(false)
  })
  it('reactivating a disabled account also updates its login permission',async()=>{
    state.users.get(id).app_metadata.can_login=false
    state.users.get(id).app_metadata.is_active=false
    expect(await updateUser(id,{is_active:true},tenant)).toMatchObject({id,is_active:true})
    expect(state.users.get(id).app_metadata.can_login).toBe(true)
  })
  it('sync archive then restore updates all access flags',async()=>{
    const operation={aggregate_id:id,created_at:'2026-09-16T10:00:00Z'} as any
    await applyStaffUserDeleted(tenant,operation)
    expect(state.users.get(id).app_metadata).toMatchObject({is_active:false,can_login:false,deleted_at:operation.created_at})
    await applyStaffUserUpsert(tenant,{...operation,payload:{id,phone:'+380671112233',full_name:'Тест',role:'cashier',is_active:true}})
    expect(state.users.get(id).app_metadata).toMatchObject({is_active:true,can_login:true,deleted_at:null})
  })
  it('protects the last owner',async()=>{
    state.users.get(id).app_metadata.role='owner'
    await expect(deleteUser(id,tenant)).rejects.toThrow('останнього власника')
    await expect(updateUser(id,{is_active:false},tenant)).rejects.toThrow('останнього власника')
    await expect(deactivateUser(id,tenant)).rejects.toThrow('останнього власника')
  })
  it('keeps the normalized login address during legacy local-phone updates and role changes',async()=>{
    const operation={aggregate_id:id,created_at:'2026-09-16T10:00:00Z'} as any
    await applyStaffUserUpsert(tenant,{...operation,payload:{id,phone:'0671112233',full_name:'Тест',role:'cashier',is_active:true}})
    expect(state.users.get(id).email).toBe('380671112233@forsage.internal')
    await applyStaffUserUpsert(tenant,{...operation,payload:{id,phone:null,full_name:'Тест',role:'tire_worker',is_active:true}})
    expect(state.users.get(id).email).toBe('380671112233@forsage.internal')
    expect(state.users.get(id).app_metadata.can_login).toBe(false)
  })
  it('can recover a previously archived owner when there is no other active owner',async()=>{
    Object.assign(state.users.get(id).app_metadata,{role:'owner',is_active:false,can_login:false,deleted_at:'2026-09-15'})
    expect(await restoreUser(id,tenant)).toMatchObject({id,role:'owner',is_active:true,deleted_at:null})
  })
})
