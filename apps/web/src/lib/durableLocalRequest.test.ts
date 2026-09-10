import { beforeEach, describe, expect, it, vi } from 'vitest'
import { durableLocalRequest } from './durableLocalRequest'
import { shiftBusinessMonth } from './businessDate'
describe('durable local requests', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } } as Storage
  beforeEach(() => values.clear())
  it('reuses identity after lost reply; next successful operation has a new identity', async () => {
    const ids: string[] = []
    await expect(durableLocalRequest('cash', { amount: 100 }, async id => { ids.push(id); throw Error('lost reply') }, storage)).rejects.toThrow()
    await durableLocalRequest('cash', { amount: 100 }, async id => { ids.push(id) }, storage)
    await durableLocalRequest('cash', { amount: 100 }, async id => { ids.push(id) }, storage)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[0])
  })
  it('deduplicates simultaneous calls and stores identity before sending', async () => {
    const send = vi.fn(async () => { expect(values.size).toBe(1); return 42 })
    expect(await Promise.all([durableLocalRequest('order', {}, send, storage), durableLocalRequest('order', {}, send, storage)])).toEqual([42, 42])
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('does not send if durable storage cannot be written', async () => {
    const send = vi.fn()
    await expect(durableLocalRequest('cash', {}, send, { ...storage, setItem: () => { throw Error('disk') } })).rejects.toThrow('disk')
    expect(send).not.toHaveBeenCalled()
  })
  it('moves calendar months without converting local midnight to the previous month', () => {
    expect(shiftBusinessMonth('2026-09', 1)).toBe('2026-10')
    expect(shiftBusinessMonth('2026-09', -1)).toBe('2026-08')
    expect(shiftBusinessMonth('2026-01', -1)).toBe('2025-12')
  })
})
