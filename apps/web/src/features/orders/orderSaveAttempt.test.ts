import { describe, expect, it, vi } from 'vitest'
import { beginOrderSaveAttempt, checkOrderSaveAttempt, clearOrderSaveAttempt, readOrderSaveAttempt } from './orderSaveAttempt'
import type { CustomerOrder } from './orderApi'
const store = () => { const rows = new Map<string,string>(); return { getItem:(k:string)=>rows.get(k)??null, setItem:(k:string,v:string)=>{rows.set(k,v)}, removeItem:(k:string)=>{rows.delete(k)} } as Storage }
const body = () => ({ comment:'Замовлення', items:[{ name:'Фільтр', qty:2, sell_price:12000 }] })
describe('durable order form save identity', () => {
  it('snapshots before writing and blocks another write until the outcome is checked', () => {
    const storage = store(), payload = body(), pending = beginOrderSaveAttempt('user:new',payload,undefined,false,storage)
    payload.items[0].qty=98
    expect(readOrderSaveAttempt('user:new',storage)?.payload.items[0].qty).toBe(2)
    expect(pending.operationId).toMatch(/^[a-f0-9-]{36}$/)
    expect(() => beginOrderSaveAttempt('user:new',payload,undefined,true,storage)).toThrow(/Спочатку перевірте/)
    expect(readOrderSaveAttempt('another:new',storage)).toBeNull()
  })
  it('read-only recovery returns the saved order without clearing its marker until the form is removed', async () => {
    const storage=store(), pending=beginOrderSaveAttempt('form',body(),'order',true,storage)
    const saved={id:'order'} as CustomerOrder, lookup=vi.fn().mockResolvedValue(saved)
    expect(await checkOrderSaveAttempt('form',lookup,storage)).toBe(saved)
    expect(lookup).toHaveBeenCalledWith(pending.operationId,'order')
    expect(readOrderSaveAttempt('form',storage)).not.toBeNull()
    clearOrderSaveAttempt('form',storage)
    expect(readOrderSaveAttempt('form',storage)).toBeNull()
  })
  it('unlocks only after confirmed absence, never on an unavailable lookup', async () => {
    const storage=store();beginOrderSaveAttempt('form',body(),undefined,false,storage)
    await expect(checkOrderSaveAttempt('form',async()=>{throw Error('offline')},storage)).rejects.toThrow('offline')
    expect(readOrderSaveAttempt('form',storage)).not.toBeNull()
    expect(await checkOrderSaveAttempt('form',async()=>null,storage)).toBeNull()
    expect(readOrderSaveAttempt('form',storage)).toBeNull()
  })
  it('fails closed for corrupt or inaccessible operation storage', () => {
    const storage=store();storage.setItem('forsage:order-save-attempt:v1:form','broken')
    expect(()=>beginOrderSaveAttempt('form',body(),undefined,false,storage)).toThrow(/Пошкоджено/)
    expect(()=>beginOrderSaveAttempt('other',body(),undefined,false,{...storage,setItem:()=>{throw Error('quota')}})).toThrow('quota')
  })
})
