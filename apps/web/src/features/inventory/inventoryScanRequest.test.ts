import { describe, expect, it, vi } from 'vitest'
import { requestInventoryScan, type ScanRequest } from './inventoryScanRequest'

describe('one scan versus transport retry', () => {
  it('reuses exactly the same request after a timeout', async () => {
    const calls: ScanRequest[] = []
    const invoke = async (input: ScanRequest) => { calls.push(input); if (calls.length === 1) throw new Error('IPC timeout'); return 1 }
    await expect(requestInventoryScan(invoke, { barcode: '123' }, true)).resolves.toBe(1)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toBe(calls[1])
    expect(calls[0].operation_id).toBeTruthy()
  })
  it('assigns different IDs to two physical scans of the same barcode', async () => {
    const invoke = vi.fn(async (input: ScanRequest) => input.operation_id)
    const a = await requestInventoryScan(invoke, { barcode: '123' }, true)
    const b = await requestInventoryScan(invoke, { barcode: '123' }, true)
    expect(a).not.toBe(b)
  })
  it('never retries an older desktop without the capability', async () => {
    const invoke = vi.fn(async () => { throw new Error('timeout') })
    await expect(requestInventoryScan(invoke, {}, false)).rejects.toThrow('timeout')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('does not retry a normal business rejection', async () => {
    const invoke = vi.fn(async () => { throw new Error('Товар не знайдено') })
    await expect(requestInventoryScan(invoke, {}, true)).rejects.toThrow('Товар не знайдено')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('stops after a second transport error', async () => {
    const invoke = vi.fn(async () => { throw new Error('timeout') })
    await expect(requestInventoryScan(invoke, {}, true)).rejects.toThrow('timeout')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})
