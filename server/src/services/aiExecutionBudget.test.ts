import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiExecutionBudget, withAiExecutionBudget } from './aiExecutionBudget.js'
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes,no) => { resolve=yes; reject=no }); return {promise,resolve,reject} }
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })
describe('whole AI operation deadline', () => {
  it('returns results and clears the deadline after success or synchronous failure', async () => {
    expect(await withAiExecutionBudget(100, b => b.run(() => 42))).toBe(42)
    await expect(withAiExecutionBudget(100, b => b.run(() => { throw Error('fixture') }))).rejects.toThrow('fixture')
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['resolve','reject'] as const)('aborts a stuck transport and ignores late %s without continuing work', async completion => {
    const transport=deferred<number>(), next=vi.fn(); let signal!: AbortSignal
    const result=withAiExecutionBudget(100, async b => {
      await b.run(s => { signal=s; return transport.promise }); next(); return 1
    })
    const check=expect(result).rejects.toMatchObject({code:'AI_TIMEOUT',status:504})
    await vi.advanceTimersByTimeAsync(100); await check
    expect(signal.aborted).toBe(true)
    if(completion==='resolve') transport.resolve(7); else transport.reject(Error('late'))
    await vi.advanceTimersByTimeAsync(1)
    expect(next).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
  it('does not turn an undefined rejection into a successful result', async () => {
    await expect(withAiExecutionBudget(100, b => b.run(() => Promise.reject(undefined)))).rejects.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not restart the clock for another model attempt', async () => {
    const second=vi.fn()
    const result=withAiExecutionBudget(100, async b => {
      await b.delay(60); return b.run(() => { second(); return new Promise<number>(()=>{}) })
    })
    const check=expect(result).rejects.toMatchObject({code:'AI_TIMEOUT'})
    await vi.advanceTimersByTimeAsync(60); expect(second).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(40); await check; expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels retry backoff and removes its timer', async () => {
    const next=vi.fn()
    const result=withAiExecutionBudget(100, async b=>{await b.delay(600);next();return 1})
    const check=expect(result).rejects.toMatchObject({code:'AI_TIMEOUT'})
    await vi.advanceTimersByTimeAsync(100);await check
    expect(next).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0)
  })
  it('propagates parent cancellation, including an already aborted parent', async () => {
    const controller=new AbortController(), work=vi.fn(()=>new Promise<number>(()=>{}))
    const pending=withAiExecutionBudget(1000,b=>b.run(work),controller.signal)
    const check=expect(pending).rejects.toMatchObject({code:'AI_TIMEOUT'})
    controller.abort();await check
    const never=vi.fn(async()=>1)
    await expect(withAiExecutionBudget(1000,never,controller.signal)).rejects.toMatchObject({code:'AI_TIMEOUT'})
    expect(never).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0)
  })
  it('checks elapsed wall-clock time even before the timer gets an event-loop turn', async () => {
    const budget=new AiExecutionBudget(100),work=vi.fn(()=>1)
    vi.setSystemTime(Date.now()+101)
    await expect(budget.run(work)).rejects.toMatchObject({code:'AI_TIMEOUT'})
    expect(work).not.toHaveBeenCalled();budget.dispose();expect(vi.getTimerCount()).toBe(0)
  })
})
