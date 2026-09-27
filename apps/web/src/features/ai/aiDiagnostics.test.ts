import {describe,expect,it,vi} from 'vitest'
const {report}=vi.hoisted(()=>({report:vi.fn()}))
vi.mock('@/lib/localDiagnostics',()=>({reportLocalError:report}))
import {reportAiFailure} from './aiDiagnostics'
describe('AI diagnostic privacy',()=>{
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
