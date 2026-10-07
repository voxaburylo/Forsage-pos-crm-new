import {describe,expect,it,vi} from 'vitest'
const {report}=vi.hoisted(()=>({report:vi.fn()}))
vi.mock('@/lib/localDiagnostics',()=>({reportLocalError:report}))
import {reportAiFailure} from './aiDiagnostics'
import {AiSupplyResponseError,collectSupplyResponse} from './aiSupplyResponse'
describe('AI diagnostic privacy',()=>{
 it.each(['missing-table','invalid-part','conflict','source-mismatch'] as const)('classifies validation %s even when wrapped and offline',kind=>{
  vi.stubGlobal('navigator',{onLine:false})
  try {
   const original=new AiSupplyResponseError('PRIVATE invoice',kind)
   reportAiFailure('recognition',new Error('PRIVATE description',{cause:original}))
   const sent=report.mock.lastCall![0] as Error
   expect(sent.message).toBe('AI_OPERATION_RECOGNITION_VALIDATION')
   expect(sent.cause).toBeUndefined()
   expect(sent.stack).not.toContain('PRIVATE')
  } finally {vi.unstubAllGlobals()}
 })
 it.each([
  {products:[{name:'Ключ',qty:1}]},
  {products:[{name:'Ключ',qty:1,purchase_price_uah:120}],invoice_total:'невідомо'},
 ])('classifies invalid parsed fields as validation, not a network fault: %j',payload=>{
  try {collectSupplyResponse([{actions:[{tool:'create_products_bulk',payload}]}],1);expect.fail('must reject')}
  catch(error) {reportAiFailure('recognition',error);expect(report.mock.lastCall![0].message).toBe('AI_OPERATION_RECOGNITION_VALIDATION')}
 })
 it('bounds cyclic cause traversal',()=>{
  const error=Error('PRIVATE');error.cause=error
  expect(()=>reportAiFailure('recognition',error)).not.toThrow()
  expect(report.mock.lastCall![0].message).toBe('AI_OPERATION_RECOGNITION_SERVER')
 })
 it('records only stage and fixed category, not document or exception contents',()=>{
  for(const stage of ['file','clipboard','recognition','write'] as const){
    const error=Object.assign(Error('secret invoice: customer and prices'),{status:401})
    reportAiFailure(stage,error)
    const sent=report.mock.lastCall![0] as Error
    expect(sent.message).toBe('AI_OPERATION_'+stage.toUpperCase()+'_SESSION')
    expect(sent.stack).not.toContain('secret invoice')
    expect(sent.cause).toBeUndefined()
  }
 })
 it('preserves timeout classification without raw server message',()=>{
  reportAiFailure('recognition',Error('timeout token=secret'))
  expect(report.mock.lastCall![0].message).toBe('AI_OPERATION_RECOGNITION_TIMEOUT')
 })
})
