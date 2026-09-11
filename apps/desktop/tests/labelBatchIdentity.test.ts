import { describe, expect, it, vi } from 'vitest'
const queue = vi.hoisted(() => ({ enqueue: vi.fn() }))
vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, screen: {} }))
vi.mock('../src/print/printerJobQueue', () => ({ enqueuePrinterJob: queue.enqueue }))
import { printLabelsTspl } from '../src/print/tsplLabelPrinter'

describe('label batch identity', () => {
  it('shares only identical pending batches and releases them after completion/failure', async () => {
    const releases: Array<() => void> = []
    queue.enqueue.mockImplementation(() => new Promise<void>((resolve) => { releases.push(resolve) }))
    const options = { printerName: 'POS-80', widthMm: 40, heightMm: 25 }
    const first = printLabelsTspl('first product', options)
    expect(printLabelsTspl('first product', { ...options, printerName: 'pos-80' })).toBe(first)
    const second = printLabelsTspl('different product', options)
    const resized = printLabelsTspl('first product', { ...options, widthMm: 50 })
    expect(second).not.toBe(first); expect(resized).not.toBe(first)
    expect(queue.enqueue).toHaveBeenCalledTimes(3)
    releases.forEach((release) => release())
    await Promise.all([first, second, resized])
    queue.enqueue.mockRejectedValueOnce(new Error('printer offline'))
    await expect(printLabelsTspl('first product', options)).rejects.toThrow('offline')
    queue.enqueue.mockResolvedValueOnce({ ok: true })
    await expect(printLabelsTspl('first product', options)).resolves.toEqual({ ok: true })
  })
})
