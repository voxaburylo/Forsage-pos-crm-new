import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks=vi.hoisted(()=>({create:vi.fn(),from:vi.fn(),usage:vi.fn(),signals:[] as AbortSignal[],brandRows:0}))
vi.mock('@anthropic-ai/sdk',()=>{
 class APIError extends Error {}
 class Anthropic {
  static APIError=APIError
  static AuthenticationError=class extends APIError {}
  static PermissionDeniedError=class extends APIError {}
  static RateLimitError=class extends APIError {}
  static BadRequestError=class extends APIError {}
  beta={messages:{stream:(body:any,options:any)=>({finalMessage:()=>mocks.create(body,options)})}}
 }
 return {default:Anthropic}
})
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
let toolId=0
/** Синтетична відповідь Claude: виклики інструментів або текст. */
const message=(calls:Array<{name:string,args:any}>=[],text='Відповідь.',stop?:string)=>({
 content:[...(text?[{type:'text',text}]:[]),...calls.map(call=>({type:'tool_use',id:'tool-'+(++toolId),name:call.name,input:call.args}))],
 stop_reason:stop??(calls.length?'tool_use':'end_turn'),
 usage:{input_tokens:10,output_tokens:2},
})
const json=(data:unknown,stop='end_turn')=>message([],typeof data==='string'?data:JSON.stringify(data),stop)
const isChat=(body:any)=>Array.isArray(body.tools)
beforeEach(()=>{
 vi.useFakeTimers();vi.resetAllMocks();mocks.signals=[];mocks.brandRows=0;toolId=0
 mocks.from.mockImplementation((table:string)=>{
  let after='',limit=500
  const query:any={
   select:()=>query,eq:()=>query,is:()=>query,order:()=>query,
   gt:(_key:string,value:string)=>{after=value;return query},
   limit:(value:number)=>{limit=value;return query},
   abortSignal:(signal:AbortSignal)=>{mocks.signals.push(signal);return query},
   single:async()=>({data:{ai_enabled:true,ai_model:'claude-sonnet-5-5',ai_api_key_encrypted:'fixture-key'},error:null}),
   insert:(data:any)=>{mocks.usage(data);return query},
   then:(resolve:any,reject:any)=>Promise.resolve({
    data:table==='brands'?Array.from({length:mocks.brandRows},(_,i)=>({id:String(i+1).padStart(8,'0'),name:'Brand '+i})).filter(r=>r.id>after).slice(0,limit):null,error:null,
   }).then(resolve,reject),
  };return query
 })
 mocks.create.mockImplementation(async(body:any)=>isChat(body)?message():json({products:[{name:'Товар',qty:2,purchase_price_uah:120}]}))
})
afterEach(()=>{expect(vi.getTimerCount()).toBe(0);vi.useRealTimers()})
describe('actual AI service budget wiring, synthetic Claude SDK and database only',()=>{
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
 it('does not hide an empty or malformed action after a valid table',async()=>{
  mocks.create.mockResolvedValueOnce(message([
   {name:'create_products_bulk',args:{products:[{name:'Ключ',qty_on_hand:1,purchase_price_uah:100}]}},
   {name:'create_products_bulk',args:{products:[]}},
  ]))
  await expect(runChat('shop','user',{message:'Накладна'})).rejects.toMatchObject({code:'AI_INVALID_RESPONSE'})
  expect(mocks.usage).toHaveBeenCalledOnce()
 })
 it('does not return proposals from an unfinished tool loop',async()=>{
  mocks.create.mockResolvedValue(message([{name:'create_products_bulk',args:{products:[{name:'Ключ',qty_on_hand:1,purchase_price_uah:100}]}}]))
  await expect(runChat('shop','user',{message:'Накладна'})).rejects.toMatchObject({code:'AI_TOOL_LIMIT'})
  expect(mocks.usage).toHaveBeenCalledOnce()
 })
 it('does not accept a refused photo recognition',async()=>{
  mocks.create.mockResolvedValue(json({products:[{name:'Ключ',qty:1,purchase_price_uah:100}]},'refusal'))
  await expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})).rejects.toMatchObject({code:'AI_INVALID_RESPONSE'})
  expect(mocks.create).toHaveBeenCalledOnce()
  expect(mocks.usage).toHaveBeenCalledOnce()
 })
 it('does not accept complete-looking tool rows after max_tokens',async()=>{
  mocks.create.mockResolvedValue(message([{name:'create_products_bulk',args:{products:[{name:'Ключ',sku:'',qty_on_hand:1,purchase_price_uah:120}]}}],'','max_tokens'))
  await expect(runChat('shop','user',{message:'Розбери накладну',fileText:'Ключ'})).rejects.toMatchObject({code:'AI_RESPONSE_TOO_LARGE',status:422})
  expect(mocks.create).toHaveBeenCalledOnce()
  expect(mocks.usage).toHaveBeenCalledOnce()
 })
 it('does not return earlier proposals after a later truncated answer',async()=>{
  mocks.create.mockResolvedValueOnce(message([{name:'create_products_bulk',args:{products:[{name:'Ключ',sku:'',qty_on_hand:1,purchase_price_uah:120}]}}]))
   .mockResolvedValueOnce(message([],'Продовження','max_tokens'))
  await expect(runChat('shop','user',{message:'Розбери накладну'})).rejects.toMatchObject({code:'AI_RESPONSE_TOO_LARGE'})
  expect(mocks.usage).toHaveBeenCalledOnce()
 })
 it('does not accept refused tool output or retry it',async()=>{
  mocks.create.mockResolvedValue(message([{name:'create_products_bulk',args:{products:[{name:'Ключ',sku:'',qty_on_hand:1,purchase_price_uah:120}]}}],'','refusal'))
  await expect(runChat('shop','user',{message:'Розбери'})).rejects.toMatchObject({code:'AI_INVALID_RESPONSE'})
  expect(mocks.create).toHaveBeenCalledOnce()
 })
 it('does not log provider error contents or return them from a key test',async()=>{
  const secret='PRIVATE_INVOICE_AND_API_KEY'
  mocks.create.mockRejectedValue(Error('401 invalid '+secret))
  await expect(testKey('test-key','claude-sonnet-5-5')).rejects.not.toHaveProperty('message',expect.stringContaining(secret))
  expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(secret)
 })
 it('does not log provider details during chat and invoice failures',async()=>{
  const secret='PRIVATE_DOCUMENT_API_KEY'
  mocks.create.mockRejectedValue(Error('401 invalid '+secret))
  await expect(runChat('shop','user',{message:'Тест'})).rejects.not.toHaveProperty('message',expect.stringContaining(secret))
  await expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})).rejects.not.toHaveProperty('message',expect.stringContaining(secret))
  expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(secret)
 })
 it('keeps source totals/line totals and removes prompts that fabricate zeros or currencies',async()=>{
  const products=[{name:'Ключ',sku:'',qty_on_hand:2,purchase_price_uah:100,line_total:200,unit:'шт',source_name:'Вихідна назва ключа'}]
  mocks.create.mockResolvedValueOnce(message([{name:'create_products_bulk',args:{products,invoice_total:200}}])).mockResolvedValueOnce(message())
  const result=await runChat('shop','user',{message:'Накладна',fileText:'Назва;Кількість;Ціна'})
  expect(result.actions[0].payload).toMatchObject({products,invoice_total:200})
  const body=mocks.create.mock.calls[0][0]
  const system=body.system[0].text
  expect(system).not.toContain('ОБОВʼЯЗКОВО qty_on_hand=0')
  expect(system).not.toContain('Усі грошові суми — у гривнях')
  const bulk=body.tools.find((tool:any)=>tool.name==='create_products_bulk')
  expect(bulk.input_schema.properties.products.items.properties.qty_on_hand.description).not.toContain('порожня — 0')
  expect(bulk.input_schema.properties.products.items.properties.line_total).toBeDefined()
  // Відповідь інструмента повертається моделі тим самим викликом, а не новою розмовою.
  const toolResult=mocks.create.mock.calls[1][0].messages.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).find((b:any)=>b.type==='tool_result')
  expect(toolResult).toMatchObject({type:'tool_result',tool_use_id:'tool-1'})
 })
 it('uses Claude Sonnet with server-side fallback and keeps the public contract',async()=>{
  const chat=await runChat('shop','user',{message:'Привіт'})
  expect(chat.reply).toBe('Відповідь.');expect(chat.actions).toEqual([])
  const invoice=await recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})
  expect(invoice.actions[0].payload.products).toHaveLength(1)
  expect(invoice.actions[0].payload.products[0].qty).toBe(2)
  expect(mocks.usage).toHaveBeenCalledTimes(2)
  expect(mocks.usage.mock.calls[0][0]).toMatchObject({model:'claude-sonnet-5-5',prompt_tokens:10,completion_tokens:2})
  const [body,options]=mocks.create.mock.calls[1]
  expect(body).toMatchObject({model:'claude-sonnet-5-5',fallbacks:'default',betas:['server-side-fallback-2026-07-01']})
  expect(body.messages[0].content[0]).toMatchObject({type:'image',source:{type:'base64',media_type:'image/png',data:'fixture'}})
  expect(options.signal).toBeInstanceOf(AbortSignal)
 })
 it('treats a stored Gemini model as Claude Sonnet',async()=>{
  const from=mocks.from.getMockImplementation()!
  mocks.from.mockImplementation((table:string)=>{const q=from(table);q.single=async()=>({data:{ai_enabled:true,ai_model:'gemini-2.5-flash',ai_api_key_encrypted:'fixture-key'},error:null});return q})
  await runChat('shop','user',{message:'Привіт'})
  expect(mocks.create.mock.calls[0][0].model).toBe('claude-sonnet-5-5')
 })
 it.each([
  {name:'Фільтр',purchase_price_uah:120},
  {name:'Фільтр',qty:2},
  {name:'Фільтр',qty:0,purchase_price_uah:120},
  {name:'Фільтр',qty:2,purchase_price_uah:-10},
  {name:{text:'Фільтр'},qty:2,purchase_price_uah:120},
 ])('rejects incomplete photo rows without inventing quantity or price: %j',async product=>{
  mocks.create.mockResolvedValue(json({products:[product]}))
  await expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})).rejects.toMatchObject({code:'AI_INVALID_RESPONSE'})
 })
 it('does not drop a malformed row between valid photo rows',async()=>{
  mocks.create.mockResolvedValue(json({products:[{name:'Фільтр',qty:2,purchase_price_uah:120},{name:'',qty:5,purchase_price_uah:20}]}))
  await expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})).rejects.toMatchObject({code:'AI_INVALID_RESPONSE'})
 })
 it('does not join photos with different invoice numbers',async()=>{
  for(const invoice_number of ['A-1','A-2'])mocks.create.mockResolvedValueOnce(json({invoice_number,products:[{name:'Фільтр',qty:2,purchase_price_uah:120}]}))
  await expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo,photo]})).rejects.toMatchObject({code:'AI_INVALID_RESPONSE'})
 })
 it('rejects a syntactically complete partial photo response ending at max_tokens',async()=>{
  mocks.create.mockResolvedValue(json({products:[{name:'Фільтр',qty:2,purchase_price_uah:120}]},'max_tokens'))
  await expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})).rejects.toMatchObject({code:'AI_RESPONSE_TOO_LARGE'})
 })
 it('refuses excess photos before calling the model instead of ignoring a fifth page',async()=>{
  await expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo,photo,photo,photo,photo]})).rejects.toMatchObject({code:'VALIDATION_ERROR'})
  expect(mocks.create).not.toHaveBeenCalled()
 })
 it('records one failed recognition attempt without supplying fabricated numbers',async()=>{
  mocks.create.mockResolvedValue(json({products:[{name:'Фільтр'}]}))
  await expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})).rejects.toMatchObject({code:'AI_INVALID_RESPONSE'})
  expect(mocks.usage).toHaveBeenCalledOnce()
 })
 it('reads JSON even when the model wraps it in a Markdown fence',async()=>{
  mocks.create.mockResolvedValue(json('```json\n'+JSON.stringify({products:[{name:'Фільтр',qty:2,purchase_price_uah:120}],invoice_total:240})+'\n```'))
  const result=await recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})
  expect(result.actions[0].payload.invoice_total).toBe(240)
 })
 it('rejects an incomplete multi-photo invoice before publishing any proposal',async()=>{
  for(const data of [
   {products:[{name:'Фільтр',qty:2,purchase_price_uah:120}],page_number:1,page_count:2},
   {products:[{name:'Гайка',qty:1,purchase_price_uah:10}],page_number:2,page_count:2,invoice_total:300},
  ]) mocks.create.mockResolvedValueOnce(json(data))
  await expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo,photo]})).rejects.toMatchObject({code:'AI_INVALID_RESPONSE'})
  expect(mocks.create).toHaveBeenCalledTimes(2)
 })
 it('accepts a totals-only continuation photo without retrying it or creating a zero-price item',async()=>{
  mocks.create.mockResolvedValueOnce(json({products:[{name:'Фільтр',qty:2,purchase_price_uah:120}]}))
    .mockResolvedValueOnce(json({products:[],invoice_total:240}))
  const result=await recognizeSupplyInvoicePhoto('shop','user',{images:[photo,photo]})
  expect(result.actions[0].payload.products).toHaveLength(1)
  expect(result.actions[0].payload.invoice_total).toBe(240)
  expect(mocks.create).toHaveBeenCalledTimes(2)
 })
 it('bounds the usage write even on the damaged-photo response path',async()=>{
  const from=mocks.from.getMockImplementation()!
  mocks.from.mockImplementation((table:string)=>table==='ai_usage'?{
   insert(){return this},abortSignal(signal:AbortSignal){mocks.signals.push(signal);return this},then(){return new Promise(()=>{})},
  }:from(table))
  mocks.create.mockResolvedValue(json('broken JSON'))
  const check=expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo]})).rejects.toMatchObject({code:'AI_TIMEOUT'})
  await vi.advanceTimersByTimeAsync(AI_TIME_LIMITS.invoice);await check
  expect(mocks.create).toHaveBeenCalledTimes(2)
  expect(mocks.signals.at(-1)?.aborted).toBe(true)
 })
 it('returns a timeout, not invalid-key, and signals the stuck SDK key test',async()=>{
  mocks.create.mockReturnValue(new Promise(()=>{}))
  const check=expect(testKey('fixture-key','claude-sonnet-5-5')).rejects.toMatchObject({code:'AI_TIMEOUT',status:504})
  await vi.advanceTimersByTimeAsync(AI_TIME_LIMITS.keyTest);await check
  expect(mocks.create.mock.calls[0][1].signal.aborted).toBe(true)
  expect(mocks.create).toHaveBeenCalledOnce()
 })
 it('stops invoice OCR without a retry or usage write after a timeout',async()=>{
  mocks.create.mockReturnValue(new Promise(()=>{}))
  const check=expect(recognizeSupplyInvoicePhoto('shop','user',{images:[photo,photo]})).rejects.toMatchObject({code:'AI_TIMEOUT'})
  await vi.advanceTimersByTimeAsync(AI_TIME_LIMITS.invoice);await check
  expect(mocks.create).toHaveBeenCalledOnce();expect(mocks.create.mock.calls[0][1].signal.aborted).toBe(true)
  expect(mocks.usage).not.toHaveBeenCalled()
 })
 it('shares one chat deadline across model steps',async()=>{
  mocks.create.mockResolvedValueOnce(message([{name:'list_categories',args:{}}])).mockReturnValue(new Promise(()=>{}))
  const check=expect(runChat('shop','user',{message:'Пошук'})).rejects.toMatchObject({code:'AI_TIMEOUT'})
  await vi.advanceTimersByTimeAsync(AI_TIME_LIMITS.chat);await check
  expect(mocks.create).toHaveBeenCalledTimes(2)
  expect(mocks.create.mock.calls[0][1].signal).toBe(mocks.create.mock.calls[1][1].signal)
  expect(mocks.create.mock.calls[1][1].signal.aborted).toBe(true);expect(mocks.usage).not.toHaveBeenCalled()
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
  mocks.create.mockResolvedValue(message([{name:'update_products_bulk',args:{updates:Array.from({length:201},(_,i)=>({product_id:'fixture-'+i,new_name:'Назва'}))}}]))
  const check=expect(runChat('shop','user',{message:'Назви'})).rejects.toMatchObject({code:'AI_TIMEOUT'})
  await vi.advanceTimersByTimeAsync(AI_TIME_LIMITS.chat);await check
  expect(readSignal?.aborted).toBe(true)
  release({data:[],error:null})
  await vi.advanceTimersByTimeAsync(0)
  expect(productReads).toBe(1)
  expect(mocks.create).toHaveBeenCalledOnce();expect(mocks.usage).not.toHaveBeenCalled()
 })
 it('does not return earlier proposals when a following catalogue read exceeds its limit',async()=>{
  mocks.brandRows=2001
  mocks.create.mockResolvedValue(message([{name:'create_order',args:{items:[{name:'Draft',qty:1}]}},{name:'list_brands',args:{}}]))
  await expect(runChat('shop','user',{message:'Перевір'})).rejects.toMatchObject({code:'AI_READ_LIMIT'})
  expect(mocks.create).toHaveBeenCalledOnce();expect(mocks.usage).not.toHaveBeenCalled()
 })
})
