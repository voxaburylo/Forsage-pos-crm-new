import { afterEach, expect, it, vi } from 'vitest'
import { createReadPoller } from './readPoller'
afterEach(() => { vi.useRealTimers() })
it('coalesces event storms and does not overlap a request slower than the interval', async () => {
  vi.useFakeTimers()
  const completions: Array<(value: number) => void> = [], read = vi.fn(() => new Promise<number>(resolve => completions.push(resolve))), onData = vi.fn()
  const poller = createReadPoller({ read, onData, intervalMs: 1000 })
  poller.wake(); for (let i=0;i<1000;i++) poller.wake()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(read).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0)
  completions.shift()!(1); await vi.advanceTimersByTimeAsync(100)
  expect(read).toHaveBeenCalledTimes(2); expect(onData).toHaveBeenCalledWith(1)
  poller.stop(); completions.shift()!(2); await vi.advanceTimersByTimeAsync(60_000)
  expect(onData).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0)
})
it('does no reads while hidden/locked and resumes on wake without queued timers', async () => {
  vi.useFakeTimers(); let allowed=false
  const read=vi.fn(async()=>1), onData=vi.fn(), poller=createReadPoller({read,onData,intervalMs:1000,canRead:()=>allowed})
  poller.wake(); await vi.advanceTimersByTimeAsync(60_000); expect(read).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1)
  allowed=true; poller.wake(); await vi.advanceTimersByTimeAsync(0); expect(onData).toHaveBeenCalledTimes(1)
  poller.stop(); await vi.advanceTimersByTimeAsync(60_000); expect(vi.getTimerCount()).toBe(0)
})
it('continues after rejection, and contains throwing error handlers', async () => {
  vi.useFakeTimers(); const read=vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue(2), onData=vi.fn(), onError=vi.fn(()=>{throw Error('UI callback')})
  const poller=createReadPoller({read,onData,onError,intervalMs:1000});poller.wake();await vi.advanceTimersByTimeAsync(1000)
  expect(onError).toHaveBeenCalledTimes(1);expect(onData).toHaveBeenCalledWith(2);poller.stop();expect(vi.getTimerCount()).toBe(0)
})
it('suppresses late results when access is locked during a request', async () => {
  vi.useFakeTimers();let allowed=true,complete!:(n:number)=>void
  const onData=vi.fn(),poller=createReadPoller({read:()=>new Promise<number>(r=>complete=r),onData,intervalMs:1000,canRead:()=>allowed})
  poller.wake();allowed=false;complete(1);await vi.advanceTimersByTimeAsync(0);expect(onData).not.toHaveBeenCalled();poller.stop()
})
it('keeps timer ownership bounded for a simulated working day', async () => {
  vi.useFakeTimers();const read=vi.fn(async()=>1),poller=createReadPoller({read,intervalMs:30_000})
  poller.wake();await vi.advanceTimersByTimeAsync(8*60*60*1000)
  expect(read).toHaveBeenCalledTimes(961);expect(vi.getTimerCount()).toBe(1);poller.stop();expect(vi.getTimerCount()).toBe(0)
})
