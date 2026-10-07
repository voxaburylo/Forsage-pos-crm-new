import { beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ bridge: {} as any }))
vi.mock('@/lib/desktopBridge',()=>({desktopBridge:()=>fixture.bridge}))
import { openAiInvoiceDraft } from './openAiInvoiceDraft'
import type { AiPendingAction } from './aiApi'
const action = {id:'a1',tool:'create_supply_invoice_bulk',payload:{products:[{name:'Новий ключ',sku:'KEY',qty:98,purchase_price_uah:10,unit:'шт'}]}} as AiPendingAction
let store: Map<string,string>
const guard = vi.fn()
beforeEach(()=>{
  store=new Map(); guard.mockReset()
  vi.stubGlobal('localStorage',{getItem:(key:string)=>store.get(key)??null,setItem:(key:string,value:string)=>store.set(key,value),removeItem:(key:string)=>store.delete(key)})
  fixture.bridge={catalog:{listCategories:async()=>[],getSettings:async()=>({})},supply:{
    previewInvoiceFromAi:vi.fn(async({rows}:any)=>rows.map((row:any)=>({name:row.name,source_name:row.name,brand:'',status:'new',product_id:null,reason:'Новий',candidates:[],validation_errors:[]}))),
    getInvoice:vi.fn(async()=>{throw Error('INVOICE_NOT_FOUND')}),
    createInvoiceFromAi:vi.fn(()=>{throw Error('Must not write while opening')}),
  }}
})
const draft=()=>JSON.parse([...store.entries()].find(([key])=>key.startsWith('forsage:supply-invoice:'))![1])
describe('AI recognition opens an ordinary draft without intermediate confirmation',()=>{
  it('stores 98 units, initial payment controls and a stable commit identity without database mutations',async()=>{
    const path=await openAiInvoiceDraft(action,'scope',guard)
    expect(path).toContain('/suppliers/invoices/new?resume=')
    expect(draft()).toMatchObject({items:[{qty:98,purchase_price:1000,total:98000}],paymentMethod:'cash',payFullNow:false})
    expect(draft().commitInvoiceId).toBeTruthy()
    expect(fixture.bridge.supply.createInvoiceFromAi).not.toHaveBeenCalled()
    const before=draft(); expect(await openAiInvoiceDraft(action,'scope',guard)).toBe(path); expect(draft()).toEqual(before)
  })
  it('does not overwrite manual edits when the chat action is reopened',async()=>{
    const path=await openAiInvoiceDraft(action,'scope',guard), key=decodeURIComponent(path.split('resume=')[1])
    const edited=draft();edited.items[0].qty=101;store.set(key,JSON.stringify(edited))
    await openAiInvoiceDraft(action,'scope',guard);expect(draft().items[0].qty).toBe(101)
  })
  it('opens a posted document rather than recreating its cleared draft',async()=>{
    const path=await openAiInvoiceDraft(action,'scope',guard), invoiceId=draft().commitInvoiceId
    store.delete(decodeURIComponent(path.split('resume=')[1]))
    fixture.bridge.supply.getInvoice.mockResolvedValue({id:invoiceId,status:'posted'})
    expect(await openAiInvoiceDraft(action,'scope',guard)).toBe('/suppliers/invoices/'+invoiceId)
    expect([...store.keys()].filter(key=>key.startsWith('forsage:supply-invoice:'))).toHaveLength(0)
  })
  it('does not resurrect a cancelled draft',async()=>{
    const path=await openAiInvoiceDraft(action,'scope',guard);store.delete(decodeURIComponent(path.split('resume=')[1]))
    await expect(openAiInvoiceDraft(action,'scope',guard)).rejects.toThrow('вже закрито')
  })
  it('keeps legacy committed action retries read-only and opens the existing document',async()=>{
    fixture.bridge.supply.previewInvoiceFromAi.mockResolvedValue([{already_saved:true,invoice_id:'legacy'}])
    fixture.bridge.supply.getInvoice.mockResolvedValue({id:'legacy',status:'posted'})
    expect(await openAiInvoiceDraft(action,'scope',guard)).toBe('/suppliers/invoices/legacy')
    expect(fixture.bridge.supply.createInvoiceFromAi).not.toHaveBeenCalled()
  })
  it('stops on preview/storage failure instead of navigating to an empty invoice',async()=>{
    fixture.bridge.supply.previewInvoiceFromAi.mockRejectedValueOnce(Error('Database unavailable'))
    await expect(openAiInvoiceDraft(action,'scope',guard)).rejects.toThrow('Database unavailable')
    expect(store.size).toBe(0)
    localStorage.setItem=()=>{throw Error('Disk full')}
    await expect(openAiInvoiceDraft(action,'scope',guard)).rejects.toThrow('Disk full')
    expect(fixture.bridge.supply.createInvoiceFromAi).not.toHaveBeenCalled()
  })
  it('checks account and permissions again after an asynchronous preview',async()=>{
    fixture.bridge.supply.previewInvoiceFromAi.mockImplementation(async()=>{guard.mockImplementation(()=>{throw Error('Account changed')});return []})
    await expect(openAiInvoiceDraft(action,'scope',guard)).rejects.toThrow('Account changed')
    expect(store.size).toBe(0)
  })
})
