import { describe, expect, it } from 'vitest'
import { aiResponseCompletionError, safeAiErrorInfo, safeAiFinishReason } from './aiResponseSafety.js'

describe('AI completion and private diagnostics', () => {
  it.each(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'])('rejects blocked content: %s', reason => {
    expect(aiResponseCompletionError({candidates:[{finishReason:reason}]})).toMatchObject({code:'AI_RESPONSE_BLOCKED',status:422})
  })
  it('checks every candidate and prompt-level blocking', () => {
    expect(aiResponseCompletionError({candidates:[{finishReason:'STOP'},{finishReason:'MAX_TOKENS'}]})).toMatchObject({code:'AI_RESPONSE_TOO_LARGE'})
    expect(aiResponseCompletionError({promptFeedback:{blockReason:'SAFETY'}})).toMatchObject({code:'AI_RESPONSE_BLOCKED'})
  })
  it.each(['OTHER','LANGUAGE','new-provider-finish-reason','MALFORMED_FUNCTION_CALL'])('rejects an unconfirmed completion %s without leaking it', reason => {
    const error=aiResponseCompletionError({candidates:[{finishReason:reason}]})
    expect(error).toMatchObject({code:'AI_INVALID_RESPONSE',status:422})
    expect(error?.message).not.toContain(reason)
  })
  it('retains normal and malformed-tool recovery paths', () => {
    expect(aiResponseCompletionError({candidates:[{finishReason:'STOP'}]})).toBeUndefined()
    expect(aiResponseCompletionError({candidates:[{finishReason:'MALFORMED_FUNCTION_CALL'}]},true)).toBeUndefined()
    expect(aiResponseCompletionError({})).toBeUndefined()
    expect(aiResponseCompletionError({promptFeedback:{blockReason:'BLOCK_REASON_UNSPECIFIED'},candidates:[{finishReason:'STOP'}]})).toBeUndefined()
  })
  it.each([
    [{status:401},'access'],[{status:429},'quota'],[{code:'23505'},'database'],
    [{code:'PGRST204'},'database'],[{message:'fetch failed'},'network'],
    [{message:'timeout'},'timeout'],[{status:422},'validation'],[{status:503},'upstream'],
  ])('records fixed error category %j', (base, category) => {
    const error={...base,message:String((base as {message?:string}).message??'')+' SECRET invoice credentials',
      details:'SECRET',stack:'SECRET',cause:{token:'SECRET'}}
    expect(safeAiErrorInfo(error).category).toBe(category)
    expect(JSON.stringify(safeAiErrorInfo(error))).not.toContain('SECRET')
  })
  it('discards arbitrary codes, finish reasons and malformed status fields', () => {
    expect(safeAiErrorInfo({code:'customer-secret',message:'customer-secret',status:'customer-secret'})).toEqual({category:'unknown'})
    expect(safeAiFinishReason('customer-secret')).toBe('UNKNOWN')
    expect(safeAiFinishReason('MAX_TOKENS')).toBe('MAX_TOKENS')
  })
})
