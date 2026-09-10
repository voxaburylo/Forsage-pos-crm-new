import { describe,it,expect } from 'vitest'
import { aiChatStorageKey, readAiChat, saveAiChat } from './aiChatStorage'
describe('AI recovery checkpoint',()=>{
  it('preserves the exact pending invoice action for safe retry after reopening',()=>{
    const data=new Map<string,string>()
    const storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v)} as unknown as Storage
    const key=aiChatStorageKey('cashier','shop',true)
    const action={id:'stable-action',tool:'create_supply_invoice_bulk',payload:{products:[{sku:'0001',name:'Фільтр',qty:8}]}}
    saveAiChat(key,storage,{entries:[{role:'model',text:'Розпізнано',actions:[action]}],applied:{}})
    expect(readAiChat(key,storage).entries[0].actions[0]).toEqual(action)
    expect(readAiChat(aiChatStorageKey('another','shop',true),storage).entries).toEqual([])
  })
  it('fails before a write if recovery storage is full',()=>{
    const storage={setItem:()=>{throw Error('quota')}} as unknown as Storage
    expect(()=>saveAiChat('key',storage,{entries:[]})).toThrow('quota')
  })
})
