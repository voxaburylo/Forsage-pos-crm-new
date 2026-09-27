import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks=vi.hoisted(()=>({send:vi.fn(),generate:vi.fn(),from:vi.fn(),usage:vi.fn(),signals:[] as AbortSignal[],brandRows:0}))
vi.mock('@google/generative-ai',()=>({
 SchemaType:{OBJECT:'OBJECT',STRING:'STRING',ARRAY:'ARRAY',NUMBER:'NUMBER',BOOLEAN:'BOOLEAN'},
 GoogleGenerativeAI:class {getGenerativeModel(){return {generateContent:mocks.generate,startChat:()=>({sendMessage:mocks.send})}}},
}))
vi.mock('../db/supabase.js',()=>({db:{from:mocks.from}}))
vi.mock('../lib/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}))
vi.mock('../lib/crypto.js',()=>({encryptSecret:(s:string)=>s,decryptSecret:(s:string)=>s}))
vi.mock('./searchService.js',()=>({searchProductsForPOS:vi.fn()}))
vi.mock('./productService.js',()=>({getProduct:vi.fn(),createProduct:vi.fn(),updateProduct:vi.fn()}))
vi.mock('./adminService.js',()=>({listCategories:vi.fn(),createCategory:vi.fn()}))
vi.mock('./customerService.js',()=>({listCustomers:vi.fn(),updateCustomer:vi.fn()}))
import { runChat, recognizeSupplyInvoicePhoto, testKey } from './aiService.js'
import { AI_TIME_LIMITS } from './aiExecutionBudget.js'
const photo={mime_type:'image/png',data_base64:'fixture'}
const response=(calls:any[]=[],text='Відповідь.',reason='STOP')=>({
 response:{functionCalls:()=>calls,text:()=>text,usageMetadata:{promptTokenCount:10,totalTokenCount:12},candidates:[{finishReason:reason}]},
})
beforeEach(()=>{
 vi.useFakeTimers();vi.resetAllMocks();mocks.signals=[];mocks.brandRows=0
 mocks.from.mockImplementation((table:string)=>{
  let after='',limit=500
  const query:any={
   select:()=>query,eq:()=>query,is:()=>query,order:()=>query,
   gt:(_key:string,value:string)=>{after=value;return query},
   limit:(value:number)=>{limit=value;return query},
   abortSignal:(signal:AbortSignal)=>{mocks.signals.push(signal);return query},
   single:async()=>({data:{ai_enabled:true,ai_model:'gemini-2.5-flash',ai_api_key_encrypted:'fixture-key'},error:null}),
   insert:(data:any)=>{mocks.usage(data);return query},
   then:(resolve:any,reject:any)=>Promise.resolve({
    data:table==='brands'?Array.from({length:mocks.brandRows},(_,i)=>({id:String(i+1).padStart(8,'0'),name:'Brand '+i})).filter(r=>r.id>after).slice(0,limit):null,error:null,
   }).then(resolve,reject),
  };return query
 })
 mocks.send.mockResolvedValue(response())
 mocks.generate.mockResolvedValue({response:{text:()=>JSON.stringify({products:[{name:'Товар',qty:2,purchase_price_uah:120}]}),usageMetadata:{promptTokenCount:5,totalTokenCount:7}}})
})
afterEach(()=>{expect(vi.getTimerCount()).toBe(0);vi.useRealTimers()})
describe('actual AI service budget wiring, synthetic SDK and database only',()=>{
 it('completes normal chat and photo proposals without changing their public contract',async()=>{
  const chat=await runChat('shop','user',{message:'Привіт'})
  expect(chat.reply).toBe('Відповідь.');expect(chat.actions).toEqual([])
  const invoice=await recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})
  expect(invoice.actions[0].payload.products).toHaveLength(1)
  expect(invoice.actions[0].payload.products[0].qty).toBe(2)
  expect(mocks.usage).toHaveBeenCalledTimes(2)
  expect(mocks.generate.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
 })
 it('returns a timeout, not invalid-key, and signals the stuck SDK key test',async()=>{
  mocks.generate.mockReturnValue(new Promise(()=>{}))
  const check=expect(testKey('fixture-key','fixture-model')).rejects.toMatchObject({code:'AI_TIMEOUT',status:504})
  await vi.advanceTimersByTimeAsync(AI_TIME_LIMITS.keyTest);await check
  expect(mocks.generate.mock.calls[0][1].signal.aborted).toBe(true)
  expect(mocks.generate).toHaveBeenCalledOnce()
 })
 it('stops invoice OCR without a retry or usage write after a timeout',async()=>{
  mocks.generate.mockReturnValue(new Promise(()=>{}))
  const check=expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo,photo]})).rejects.toMatchObject({code:'AI_TIMEOUT'})
  await vi.advanceTimersByTimeAsync(AI_TIME_LIMITS.invoice);await check
  expect(mocks.generate).toHaveBeenCalledOnce();expect(mocks.generate.mock.calls[0][1].signal.aborted).toBe(true)
  expect(mocks.usage).not.toHaveBeenCalled()
 })
 it('shares the chat deadline across transient errors and retry backoff',async()=>{
  mocks.send.mockRejectedValueOnce(Error('503 unavailable')).mockReturnValue(new Promise(()=>{}))
  const check=expect(runChat('shop','user',{message:'Пошук'})).rejects.toMatchObject({code:'AI_TIMEOUT'})
  await vi.advanceTimersByTimeAsync(600);expect(mocks.send).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(AI_TIME_LIMITS.chat-600);await check
  expect(mocks.send.mock.calls[0][1].signal).toBe(mocks.send.mock.calls[1][1].signal)
  expect(mocks.send.mock.calls[1][1].signal.aborted).toBe(true);expect(mocks.usage).not.toHaveBeenCalled()
 })
 it('uses the remaining budget for salvage instead of starting another deadline',async()=>{
  mocks.send.mockImplementationOnce(()=>new Promise(resolve=>setTimeout(()=>resolve(response([],'','MALFORMED_FUNCTION_CALL')),40_000)))
   .mockResolvedValue(response([],'','MALFORMED_FUNCTION_CALL'))
  mocks.generate.mockReturnValue(new Promise(()=>{}))
  const check=expect(runChat('shop','user',{message:'Фото',images:[photo]})).rejects.toMatchObject({code:'AI_TIMEOUT'})
  await vi.advanceTimersByTimeAsync(40_000);expect(mocks.generate).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(AI_TIME_LIMITS.chat-40_000);await check
  expect(mocks.generate.mock.calls[0][1].signal).toBe(mocks.send.mock.calls[0][1].signal)
  expect(mocks.generate.mock.calls[0][1].signal.aborted).toBe(true)
 })
 it('stops proposal pagination after timeout even if its first database read resolves late',async()=>{
  const baseFrom=mocks.from.getMockImplementation()!
  let release!:(value:any)=>void
  const pending=new Promise(resolve=>{release=resolve})
  let productReads=0
  let readSignal:AbortSignal|undefined
  mocks.from.mockImplementation((table:string)=>{
   if(table!=='products') return baseFrom(table)
   productReads++
   const query:any={
    select:()=>query,eq:()=>query,in:()=>query,
    abortSignal:(signal:AbortSignal)=>{readSignal=signal;return query},
    then:(resolve:any,reject:any)=>pending.then(resolve,reject),
   }
   return query
  })
  mocks.send.mockResolvedValue(response([{name:'update_products_bulk',args:{updates:Array.from({length:201},(_,i)=>({product_id:'fixture-'+i,new_name:'Назва'}))}}]))
  const check=expect(runChat('shop','user',{message:'Назви'})).rejects.toMatchObject({code:'AI_TIMEOUT'})
  await vi.advanceTimersByTimeAsync(AI_TIME_LIMITS.chat);await check
  expect(readSignal?.aborted).toBe(true)
  release({data:[],error:null})
  await vi.advanceTimersByTimeAsync(0)
  expect(productReads).toBe(1)
  expect(mocks.send).toHaveBeenCalledOnce();expect(mocks.usage).not.toHaveBeenCalled()
 })
 it('does not return earlier proposals when a following catalogue read exceeds its limit',async()=>{
  mocks.brandRows=2001
  mocks.send.mockResolvedValue(response([{name:'create_order',args:{items:[{name:'Draft',qty:1}]}},{name:'list_brands',args:{}}]))
  await expect(runChat('shop','user',{message:'Перевір'})).rejects.toMatchObject({code:'AI_READ_LIMIT'})
  expect(mocks.send).toHaveBeenCalledOnce();expect(mocks.usage).not.toHaveBeenCalled()
 })
})
