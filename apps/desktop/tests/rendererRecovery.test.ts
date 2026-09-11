import { afterEach, describe, expect, it, vi } from 'vitest'
import { RendererRecovery } from '../src/rendererRecovery'

describe('coordinated renderer recovery', () => {
  afterEach(() => vi.useRealTimers())
  it('joins a crash during initial load and never starts concurrent loads', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const load = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve })).mockResolvedValue(undefined)
    const recovery = new RendererRecovery({ load, isDestroyed: () => false, retry: vi.fn(), delays: [10] })
    const first = recovery.start()
    await Promise.resolve()
    expect(recovery.crashed()).toBe(first)
    expect(load).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(10)
    await first
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('does not reenter native loading if the load call immediately reports a crash', async () => {
    vi.useFakeTimers()
    let reentrant: Promise<void> | undefined
    const load = vi.fn(async () => { if (load.mock.calls.length === 1) reentrant = recovery.crashed() })
    const recovery = new RendererRecovery({ load, isDestroyed: () => false, retry: vi.fn(), delays: [10] })
    const first = recovery.start()
    await vi.runAllTimersAsync()
    await first
    expect(reentrant).toBe(first)
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('cancels pending retries when the window closes', async () => {
    vi.useFakeTimers()
    const load = vi.fn().mockRejectedValue(new Error('ERR_FAILED'))
    const recovery = new RendererRecovery({ load, isDestroyed: () => false, retry: vi.fn(), delays: [100] })
    const result = recovery.start()
    await vi.advanceTimersByTimeAsync(0)
    recovery.stop()
    await result
    await vi.runAllTimersAsync()
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('limits load errors and allows no retries after repeated crashes', async () => {
    vi.useFakeTimers()
    const load = vi.fn().mockRejectedValue(new Error('ERR_FAILED'))
    const recovery = new RendererRecovery({ load, isDestroyed: () => false, retry: vi.fn(), delays: [10] })
    const pending = expect(recovery.start()).rejects.toThrow('ERR_FAILED')
    await vi.runAllTimersAsync(); await pending
    expect(load).toHaveBeenCalledTimes(2)
    load.mockResolvedValue(undefined)
    await recovery.crashed(); await recovery.crashed()
    await expect(recovery.crashed()).rejects.toThrow('кілька разів')
    const before = load.mock.calls.length
    await recovery.start()
    expect(load).toHaveBeenCalledTimes(before)
  })
  it('does not load a destroyed window and resets the crash window after a minute', async () => {
    const load = vi.fn().mockResolvedValue(undefined)
    await new RendererRecovery({ load, isDestroyed: () => true, retry: vi.fn() }).start()
    expect(load).not.toHaveBeenCalled()
    vi.useFakeTimers()
    const recovery = new RendererRecovery({ load, isDestroyed: () => false, retry: vi.fn() })
    await recovery.crashed(); await recovery.crashed()
    vi.advanceTimersByTime(60001)
    await recovery.crashed()
    expect(load).toHaveBeenCalledTimes(3)
  })
})
