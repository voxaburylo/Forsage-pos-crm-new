import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks=vi.hoisted(()=>({send:vi.fn(),generate:vi.fn(),from:vi.fn(),usage:vi.fn(),model:vi.fn(),signals:[] as AbortSignal[],brandRows:0}))
vi.mock('@google/generative-ai',()=>({
 SchemaType:{OBJECT:'OBJECT',STRING:'STRING',ARRAY:'ARRAY',NUMBER:'NUMBER',BOOLEAN:'BOOLEAN'},
 GoogleGenerativeAI:class {getGenerativeModel(options:any){mocks.model(options);return {generateContent:mocks.generate,startChat:()=>({sendMessage:mocks.send})}}},
}))
vi.mock('../db/supabase.js',()=>({db:{from:mocks.from}}))
vi.mock('../lib/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}))
vi.mock('../lib/crypto.js',()=>({encryptSecret:(s:string)=>s,decryptSecret:(s:string)=>s}))
vi.mock('./searchService.js',()=>({searchProductsForPOS:vi.fn()}))
vi.mock('./productService.js',()=>({getProduct:vi.fn(),createProduct:vi.fn(),updateProduct:vi.fn()}))
vi.mock('./adminService.js',()=>({listCategories:vi.fn(),createCategory:vi.fn()}))
vi.mock('./customerService.js',()=>({listCustomers:vi.fn(),updateCustomer:vi.fn()}))
import { runChat, recognizeSupplyInvoicePhoto, testKey, saveAiConfig, getUsageSummary, recordAiUsage } from './aiService.js'
import { AI_TIME_LIMITS } from './aiExecutionBudget.js'
import { logger } from '../lib/logger.js'
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
 it('does not return database payloads when AI settings cannot be saved',async()=>{
  const query:any={update:()=>query,eq:()=>query,select:()=>query,single:async()=>({data:null,error:{code:'XX000',message:'PRIVATE_KEY_AND_SETTINGS'}})}
  mocks.from.mockReturnValue(query)
  await expect(saveAiConfig('shop',{enabled:true})).rejects.toMatchObject({code:'DB_ERROR',message:expect.not.stringContaining('PRIVATE_')})
  expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('PRIVATE_')
 })
 it('keeps the useful missing-schema explanation for AI settings',async()=>{
  const query:any={update:()=>query,eq:()=>query,select:()=>query,single:async()=>({data:null,error:{code:'PGRST204',message:'PRIVATE_SCHEMA_DETAILS'}})}
  mocks.from.mockReturnValue(query)
  await expect(saveAiConfig('shop',{enabled:true})).rejects.toMatchObject({code:'AI_SCHEMA_DRIFT',message:expect.stringContaining('120_ai_assistant.sql')})
 })
 it('does not return usage database errors as private response text',async()=>{
  const query:any={select:()=>query,eq:()=>query,gte:()=>query,limit:async()=>({data:null,error:{code:'XX000',message:'PRIVATE_USAGE_DATA'}})}
  mocks.from.mockReturnValue(query)
  await expect(getUsageSummary('shop')).rejects.toMatchObject({code:'DB_ERROR',message:expect.not.stringContaining('PRIVATE_')})
  expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('PRIVATE_')
 })
 it('records returned usage failures without breaking a successful AI response or exposing payloads',async()=>{
  mocks.from.mockReturnValue({insert:async()=>({error:{code:'XX000',message:'PRIVATE_USAGE_BODY'}})})
  await expect(recordAiUsage('shop','user','fixture-model',1,2)).resolves.toBeUndefined()
  expect(logger.warn).toHaveBeenCalledOnce()
  expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('PRIVATE_')
 })
 it('does not return a partial proposal after syntax recovery is exhausted',async()=>{
  mocks.send.mockResolvedValueOnce(response([{name:'create_products_bulk',args:{products:[{name:'Ключ',qty_on_hand:1,purchase_price_uah:100}]}}]))
   .mockResolvedValue(response([],'','MALFORMED_FUNCTION_CALL'))
  await expect(runChat('shop','user',{message:'Накладна'})).rejects.toMatchObject({code:'AI_INVALID_RESPONSE'})
  expect(mocks.usage).toHaveBeenCalledOnce()
 })
 it('does not hide an empty or malformed action after a valid table',async()=>{
  mocks.send.mockResolvedValueOnce(response([
   {name:'create_products_bulk',args:{products:[{name:'Ключ',qty_on_hand:1,purchase_price_uah:100}]}},
   {name:'create_products_bulk',args:{products:[]}},
  ]))
  await expect(runChat('shop','user',{message:'Накладна'})).rejects.toMatchObject({code:'AI_INVALID_RESPONSE'})
  expect(mocks.usage).toHaveBeenCalledOnce()
 })
 it('does not return proposals from an unfinished tool loop',async()=>{
  mocks.send.mockResolvedValue(response([{name:'create_products_bulk',args:{products:[{name:'Ключ',qty_on_hand:1,purchase_price_uah:100}]}}]))
  await expect(runChat('shop','user',{message:'Накладна'})).rejects.toMatchObject({code:'AI_TOOL_LIMIT'})
  expect(mocks.usage).toHaveBeenCalledOnce()
 })
 it('does not accept blocked content from the dedicated photo recognizer',async()=>{
  mocks.generate.mockResolvedValue(response([],JSON.stringify({products:[{name:'Ключ',qty:1,purchase_price_uah:100}]}),'SAFETY'))
  await expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})).rejects.toMatchObject({code:'AI_RESPONSE_BLOCKED'})
  expect(mocks.generate).toHaveBeenCalledOnce()
  expect(mocks.usage).toHaveBeenCalledOnce()
 })
 it('does not accept complete-looking tool rows after MAX_TOKENS',async()=>{
  mocks.send.mockResolvedValue(response([{name:'create_products_bulk',args:{products:[{name:'Ключ',sku:'',qty_on_hand:1,purchase_price_uah:120}]}}],'','MAX_TOKENS'))
  await expect(runChat('shop','user',{message:'Розбери накладну',fileText:'Ключ'})).rejects.toMatchObject({code:'AI_RESPONSE_TOO_LARGE',status:422})
  expect(mocks.send).toHaveBeenCalledOnce()
  expect(mocks.usage).toHaveBeenCalledOnce()
 })
 it('does not return earlier proposals after a later truncated answer',async()=>{
  mocks.send.mockResolvedValueOnce(response([{name:'create_products_bulk',args:{products:[{name:'Ключ',sku:'',qty_on_hand:1,purchase_price_uah:120}]}}]))
   .mockResolvedValueOnce(response([],'Продовження','MAX_TOKENS'))
  await expect(runChat('shop','user',{message:'Розбери накладну'})).rejects.toMatchObject({code:'AI_RESPONSE_TOO_LARGE'})
  expect(mocks.usage).toHaveBeenCalledOnce()
 })
 it('does not accept blocked tool output or retry it as a syntax error',async()=>{
  mocks.send.mockResolvedValue(response([{name:'create_products_bulk',args:{products:[{name:'Ключ',sku:'',qty_on_hand:1,purchase_price_uah:120}]}}],'','SAFETY'))
  await expect(runChat('shop','user',{message:'Розбери'})).rejects.toMatchObject({code:'AI_RESPONSE_BLOCKED'})
  expect(mocks.send).toHaveBeenCalledOnce()
 })
 it('does not recover a truncated JSON response as a successful fallback',async()=>{
  mocks.send.mockResolvedValue(response([],'','MALFORMED_FUNCTION_CALL'))
  mocks.generate.mockResolvedValue(response([],JSON.stringify({products:[{name:'Ключ',qty_on_hand:1,purchase_price_uah:100}]}),'MAX_TOKENS'))
  await expect(runChat('shop','user',{message:'Фото',images:[photo]})).rejects.toMatchObject({code:'AI_RESPONSE_TOO_LARGE'})
  expect(mocks.usage).toHaveBeenCalledOnce()
  expect(mocks.usage.mock.calls[0][0].prompt_tokens).toBe(40)
 })
 it('does not log provider error contents or return them from a key test',async()=>{
  const secret='PRIVATE_INVOICE_AND_API_KEY'
  mocks.generate.mockRejectedValue(Error('401 invalid '+secret))
  await expect(testKey('test-key','test-model')).rejects.not.toHaveProperty('message',expect.stringContaining(secret))
  expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(secret)
 })
 it('does not log provider details during chat and invoice failures',async()=>{
  const secret='PRIVATE_DOCUMENT_API_KEY'
  mocks.send.mockRejectedValue(Error('401 invalid '+secret))
  await expect(runChat('shop','user',{message:'Тест'})).rejects.toBeDefined()
  mocks.generate.mockRejectedValue(Error('401 invalid '+secret))
  await expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})).rejects.toBeDefined()
  expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(secret)
 })
 it('keeps source totals/line totals and removes prompts that fabricate zeros or currencies',async()=>{
  const products=[{name:'Ключ',sku:'',qty_on_hand:2,purchase_price_uah:100,line_total:200,unit:'шт',source_name:'Вихідна назва ключа'}]
  mocks.send.mockResolvedValueOnce(response([{name:'create_products_bulk',args:{products,invoice_total:200}}])).mockResolvedValueOnce(response())
  const result=await runChat('shop','user',{message:'Накладна',fileText:'Назва;Кількість;Ціна'})
  expect(result.actions[0].payload).toMatchObject({products,invoice_total:200})
  const config=mocks.model.mock.calls[0][0]
  expect(config.systemInstruction).not.toContain('ОБОВʼЯЗКОВО qty_on_hand=0')
  expect(config.systemInstruction).not.toContain('Усі грошові суми — у гривнях')
  const bulk=config.tools[0].functionDeclarations.find((tool:any)=>tool.name==='create_products_bulk')
  expect(bulk.parameters.properties.products.items.properties.qty_on_hand.description).not.toContain('порожня — 0')
  expect(bulk.parameters.properties.products.items.properties.line_total).toBeDefined()
 })
 it('completes normal chat and photo proposals without changing their public contract',async()=>{
  const chat=await runChat('shop','user',{message:'Привіт'})
  expect(chat.reply).toBe('Відповідь.');expect(chat.actions).toEqual([])
  const invoice=await recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})
  expect(invoice.actions[0].payload.products).toHaveLength(1)
  expect(invoice.actions[0].payload.products[0].qty).toBe(2)
  expect(mocks.usage).toHaveBeenCalledTimes(2)
  expect(mocks.generate.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
 })
 it.each([
  {name:'Фільтр',purchase_price_uah:120},
  {name:'Фільтр',qty:2},
  {name:'Фільтр',qty:0,purchase_price_uah:120},
  {name:'Фільтр',qty:2,purchase_price_uah:-10},
  {name:{text:'Фільтр'},qty:2,purchase_price_uah:120},
 ])('rejects incomplete photo rows without inventing quantity or price: %j',async product=>{
  mocks.generate.mockResolvedValue({response:{text:()=>JSON.stringify({products:[product]})}})
  await expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})).rejects.toMatchObject({code:'AI_INVALID_RESPONSE'})
 })
 it('does not drop a malformed row between valid photo rows',async()=>{
  mocks.generate.mockResolvedValue({response:{text:()=>JSON.stringify({products:[{name:'Фільтр',qty:2,purchase_price_uah:120},{name:'',qty:5,purchase_price_uah:20}]})}})
  await expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})).rejects.toMatchObject({code:'AI_INVALID_RESPONSE'})
 })
 it('does not join photos with different invoice numbers',async()=>{
  for(const invoice_number of ['A-1','A-2'])mocks.generate.mockResolvedValueOnce({response:{text:()=>JSON.stringify({invoice_number,products:[{name:'Фільтр',qty:2,purchase_price_uah:120}]})}})
  await expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo,photo]})).rejects.toMatchObject({code:'AI_INVALID_RESPONSE'})
 })
 it('rejects a syntactically complete partial photo response ending at MAX_TOKENS',async()=>{
  mocks.generate.mockResolvedValue(response([],JSON.stringify({products:[{name:'Фільтр',qty:2,purchase_price_uah:120}]}),'MAX_TOKENS'))
  await expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})).rejects.toMatchObject({code:'AI_RESPONSE_TOO_LARGE'})
 })
 it('refuses excess photos before calling the model instead of ignoring a fifth page',async()=>{
  await expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo,photo,photo,photo,photo]})).rejects.toMatchObject({code:'VALIDATION_ERROR'})
  expect(mocks.generate).not.toHaveBeenCalled()
 })
 it('records one failed recognition attempt without supplying fabricated numbers',async()=>{
  mocks.generate.mockResolvedValue({response:{text:()=>JSON.stringify({products:[{name:'Фільтр'}]}),usageMetadata:{promptTokenCount:5,totalTokenCount:7}}})
  await expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})).rejects.toMatchObject({code:'AI_INVALID_RESPONSE'})
  expect(mocks.usage).toHaveBeenCalledOnce()
 })
 it('carries a verified document total from OCR through the public proposal',async()=>{
  mocks.generate.mockResolvedValue(response([],JSON.stringify({products:[{name:'Фільтр',qty:2,purchase_price_uah:120}],invoice_total:240})))
  const result=await recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})
  expect(result.actions[0].payload.invoice_total).toBe(240)
 })
 it('rejects an incomplete multi-photo invoice before publishing any proposal',async()=>{
  for(const data of [
   {products:[{name:'Фільтр',qty:2,purchase_price_uah:120}],page_number:1,page_count:2},
   {products:[{name:'Гайка',qty:1,purchase_price_uah:10}],page_number:2,page_count:2,invoice_total:300},
  ]) mocks.generate.mockResolvedValueOnce(response([],JSON.stringify(data)))
  await expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo,photo]})).rejects.toMatchObject({code:'AI_INVALID_RESPONSE'})
  expect(mocks.generate).toHaveBeenCalledTimes(2)
 })
 it('accepts a totals-only continuation photo without retrying it or creating a zero-price item',async()=>{
  mocks.generate.mockResolvedValueOnce(response([],JSON.stringify({products:[{name:'Фільтр',qty:2,purchase_price_uah:120}]})))
    .mockResolvedValueOnce(response([],JSON.stringify({products:[],invoice_total:240})))
  const result=await recognizeSupplyInvoicePhoto('shop','user',{images:[photo,photo]})
  expect(result.actions[0].payload.products).toHaveLength(1)
  expect(result.actions[0].payload.invoice_total).toBe(240)
  expect(mocks.generate).toHaveBeenCalledTimes(2)
 })
 it('bounds the usage write even on the damaged-photo response path',async()=>{
  const from=mocks.from.getMockImplementation()!
  mocks.from.mockImplementation((table:string)=>table==='ai_usage'?{
   insert(){return this},abortSignal(signal:AbortSignal){mocks.signals.push(signal);return this},then(){return new Promise(()=>{})},
  }:from(table))
  mocks.generate.mockResolvedValue(response([],'broken JSON'))
  const check=expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})).rejects.toMatchObject({code:'AI_TIMEOUT'})
  await vi.advanceTimersByTimeAsync(AI_TIME_LIMITS.invoice);await check
  expect(mocks.generate).toHaveBeenCalledTimes(2)
  expect(mocks.signals.at(-1)?.aborted).toBe(true)
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
