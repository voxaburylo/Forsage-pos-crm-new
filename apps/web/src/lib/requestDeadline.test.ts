import { afterEach, expect, it, vi } from 'vitest'
import { withRequestDeadline } from './requestDeadline'
afterEach(()=>vi.useRealTimers())
it.each(['auth','body'])('bounds a stalled %s promise',async()=>{
 vi.useFakeTimers();const promise=withRequestDeadline(()=>new Promise(()=>{}),1000)
 const assertion=expect(promise).rejects.toThrow('вчасно');await vi.advanceTimersByTimeAsync(1001);await assertion
})
it('passes abort and clears timers after success',async()=>{vi.useFakeTimers();expect(await withRequestDeadline(async()=>42,1000)).toBe(42);expect(vi.getTimerCount()).toBe(0)})
it('does not start a request already cancelled',async()=>{const caller=new AbortController();caller.abort();const work=vi.fn();await expect(withRequestDeadline(work,1000,caller.signal)).rejects.toThrow();expect(work).not.toHaveBeenCalled()})
