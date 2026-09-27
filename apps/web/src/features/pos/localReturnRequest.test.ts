import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateReturnBody, CustomerReturn } from '@/types/return'
import { createLocalReturn, checkLocalReturnAttempt, readLocalReturnAttempt } from './localReturnRequest'
import { parseReturnQuantity } from './returnQuantity'

describe('durable non-fiscal returns', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key,value) }, removeItem: (key: string) => { values.delete(key) } } as Storage
  const body: CreateReturnBody = { sale_id:'sale',reason:'other',reason_note:'Тест',refund_method:'cash',stock_action:'return_to_stock',items:[{sale_item_id:'line',product_id:'product',quantity:1.5,condition:'good'}] }
  const saved = { id:'saved',refund_kopecks:1500 } as CustomerReturn
  const transport = () => ({ getOpenShift:vi.fn(async()=>({id:'shift'})),createReturn:vi.fn(async(_input: unknown)=>saved),getReturnByOperation:vi.fn(async(_id:string):Promise<CustomerReturn|null>=>null) })
  beforeEach(()=>values.clear())
  it('coalesces double submits and persists identity before sending', async()=>{
    const api=transport()
    api.createReturn.mockImplementation(async()=>{ expect(readLocalReturnAttempt('user',storage)?.id).toBe('op');return saved })
    const [a,b]=await Promise.all([createLocalReturn('user','cashier',body,api,storage,'op'),createLocalReturn('user','cashier',body,api,storage,'other')])
    expect(a.id).toBe(b.id);expect(api.createReturn).toHaveBeenCalledTimes(1);expect(values.size).toBe(0)
  })
  it('looks up an already committed return after a lost reply instead of paying again', async()=>{
    const api=transport();api.createReturn.mockRejectedValue(Error('IPC lost'));api.getReturnByOperation.mockResolvedValue(saved)
    expect(await createLocalReturn('user','cashier',body,api,storage,'op')).toBe(saved)
    expect(api.createReturn).toHaveBeenCalledTimes(1);expect(api.getReturnByOperation).toHaveBeenCalledWith('op');expect(values.size).toBe(0)
  })
  it('sends an immutable snapshot even when the caller changes the form while IPC is pending', async()=>{
    const api=transport(), mutable=structuredClone(body)
    const task=createLocalReturn('user','cashier',mutable,api,storage,'op')
    mutable.items[0].quantity=2.5
    await task
    expect(api.createReturn.mock.calls[0][0]).toMatchObject({items:[{quantity:1.5}]})
  })
  it.each([NaN,Infinity,0,-1])('rejects invalid quantity %s before recording or dispatching', async quantity=>{
    const api=transport(), invalid=structuredClone(body)
    invalid.items[0].quantity=quantity
    await expect(createLocalReturn('user','cashier',invalid,api,storage)).rejects.toThrow('Некоректна')
    expect(api.createReturn).not.toHaveBeenCalled();expect(values.size).toBe(0)
  })
  it('clears a failed transaction only after authoritative absence was confirmed', async()=>{
    const api=transport();api.createReturn.mockRejectedValue(Error('Cash insufficient'))
    await expect(createLocalReturn('user','cashier',body,api,storage)).rejects.toThrow('Cash insufficient')
    expect(values.size).toBe(0)
  })
  it('blocks different payloads while status is unknown and survives reopening', async()=>{
    const api=transport();api.createReturn.mockRejectedValue(Error('lost'));api.getReturnByOperation.mockRejectedValue(Error('offline'))
    await expect(createLocalReturn('user','cashier',body,api,storage,'op')).rejects.toThrow('не підтверджено')
    expect(readLocalReturnAttempt('user',storage)?.id).toBe('op')
    await expect(createLocalReturn('user','cashier',{...body,reason_note:'changed'},api,storage)).rejects.toThrow('попереднього')
    expect(api.createReturn).toHaveBeenCalledTimes(1)
    api.getReturnByOperation.mockResolvedValue(saved)
    expect(await checkLocalReturnAttempt('user',api.getReturnByOperation,storage)).toBe(saved)
    expect(api.createReturn).toHaveBeenCalledTimes(1);expect(values.size).toBe(0)
  })
  it('retry retains the original shift and identity rather than switching to the next day', async()=>{
    const api=transport();api.createReturn.mockRejectedValue(Error('lost'));api.getReturnByOperation.mockRejectedValue(Error('offline'))
    await expect(createLocalReturn('user','cashier',body,api,storage,'op')).rejects.toThrow()
    api.getOpenShift.mockResolvedValue({id:'next-day'});api.createReturn.mockResolvedValue(saved)
    await createLocalReturn('user','cashier',body,api,storage,'new-id')
    expect(api.createReturn.mock.calls[1][0]).toMatchObject({shift_id:'shift',client_operation_id:'op'})
    expect(api.getOpenShift).toHaveBeenCalledTimes(1)
  })
  it('does not send when durable storage cannot be written', async()=>{
    const api=transport(),broken={...storage,setItem:()=>{throw Error('disk full')}} as Storage
    await expect(createLocalReturn('user','cashier',body,api,broken)).rejects.toThrow('disk full')
    expect(api.createReturn).not.toHaveBeenCalled()
  })
  it('does not discard a corrupt journal or a still-unreachable operation', async()=>{
    values.set('forsage:return-attempt:v1:user','broken')
    expect(()=>readLocalReturnAttempt('user',storage)).toThrow('Пошкоджено')
    expect(values.size).toBe(1)
  })
  it('does not mix different cashier scopes', async()=>{
    const api=transport();api.createReturn.mockRejectedValue(Error('lost'));api.getReturnByOperation.mockRejectedValue(Error('offline'))
    await expect(createLocalReturn('one','one',body,api,storage)).rejects.toThrow()
    expect(readLocalReturnAttempt('two',storage)).toBeNull()
  })
  it.each(['1,5','1.5','0.125',2.5,0])('preserves fractional return quantity %s', value=>{
    expect(parseReturnQuantity(value)).toBe(Number(String(value).replace(',','.')))
  })
  it.each(['','-1','1.0001','1x','1e3','Infinity'])('rejects invalid quantity %s',value=>expect(parseReturnQuantity(value)).toBeNull())
})
