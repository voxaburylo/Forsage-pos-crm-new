import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('node:worker_threads', () => ({ Worker: fake.create }))
import { BlackBox } from '../src/diagnostics/blackBox'

describe('black box lifecycle does not block business operations', () => {
  let worker: EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-11T00:00:00Z'))
    worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), terminate: vi.fn().mockResolvedValue(0), unref: vi.fn() })
    fake.create.mockReset()
    fake.create.mockImplementation(function () { return worker })
  })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
  const records = () => worker.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'record')

  it('sanitizes data before handing it to the writer', () => {
    const box = new BlackBox('isolated-test-directory')
    box.record('command-end', { channel: 'desktop:auth:login', duration_ms: 12, password: 'PRIVATE_PASSWORD', args: ['PRIVATE_INPUT'] })
    expect(records()).toHaveLength(1)
    expect(records()[0].details).toEqual({ channel: 'desktop:auth:login', duration_ms: 12 })
    expect(JSON.stringify(worker.postMessage.mock.calls)).not.toContain('PRIVATE_')
    expect(worker.unref).toHaveBeenCalledOnce()
  })

  it('bounds an unresponsive writer at 500 pending records and reports dropped events', () => {
    const box = new BlackBox('isolated-test-directory')
    for (let i = 0; i < 520; i++) box.record('command-end', { sequence: i })
    expect(records()).toHaveLength(500)
    worker.emit('message', { type: 'ack' })
    box.record('command-end', { sequence: 521 })
    expect(records()).toHaveLength(501)
    for (let i = 0; i < 501; i++) worker.emit('message', { type: 'ack' })
    vi.advanceTimersByTime(30_000)
    expect(records().find(message => message.event === 'health').details.dropped).toBe(20)
    expect(records()).toHaveLength(502)
  })

  it('survives failure to create a writer without a timer or rejected close', async () => {
    fake.create.mockImplementation(() => { throw new Error('EACCES fixture') })
    const box = new BlackBox('isolated-test-directory')
    expect(() => box.record('command-end')).not.toThrow()
    await expect(box.close()).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['error', 'exit'])('stops safely when its writer emits %s', async event => {
    const box = new BlackBox('isolated-test-directory')
    worker.emit(event, event === 'error' ? new Error('fixture failure') : 1)
    box.record('command-end')
    vi.advanceTimersByTime(30_000)
    expect(worker.postMessage).not.toHaveBeenCalled()
    await expect(box.close()).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('tolerates unavailable storage acknowledgements and resumes accepting records', () => {
    const box = new BlackBox('isolated-test-directory')
    box.record('command-end', { sequence: 1 })
    expect(() => worker.emit('message', { type: 'io-failed' })).not.toThrow()
    worker.emit('message', { type: 'ack' })
    box.record('command-end', { sequence: 2 })
    expect(records().map(message => message.details.sequence)).toEqual([1, 2])
  })

  it('stops on a broken message channel without throwing into the cashier operation', async () => {
    const box = new BlackBox('isolated-test-directory')
    worker.postMessage.mockImplementation(() => { throw new Error('closed channel') })
    expect(() => box.record('command-end')).not.toThrow()
    await expect(box.close()).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shares one close request and does not send new records while closing', async () => {
    const box = new BlackBox('isolated-test-directory')
    const first = box.close()
    expect(box.close()).toBe(first)
    box.record('command-end')
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'close' })
    worker.emit('message', { type: 'closed' })
    await first
    expect(worker.terminate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds close at two seconds when the writer never replies', async () => {
    const box = new BlackBox('isolated-test-directory')
    let done = false
    const closing = box.close().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(1_999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await closing
    expect(done).toBe(true)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resolves close if sending the close request fails', async () => {
    const box = new BlackBox('isolated-test-directory')
    worker.postMessage.mockImplementation(() => { throw new Error('closed channel') })
    await expect(box.close()).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})
