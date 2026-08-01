import { afterEach, describe, expect, it, vi } from 'vitest'
import { enqueuePrinterJob } from '../src/print/printerJobQueue'
import { assertPrinterRole } from '../src/print/printerRole'
import { withPrintTimeout } from '../src/print/printTimeout'

describe('desktop print safety', () => {
  afterEach(() => vi.useRealTimers())

  it('serializes jobs only for the same physical printer', async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = enqueuePrinterJob('POS-58', async () => {
      events.push('receipt-1-start')
      await firstGate
      events.push('receipt-1-end')
    })
    const second = enqueuePrinterJob('pos-58', async () => {
      events.push('receipt-2-start')
    })
    const label = enqueuePrinterJob('POS-80', async () => {
      events.push('label-start')
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(events).toContain('receipt-1-start')
    expect(events).toContain('label-start')
    expect(events).not.toContain('receipt-2-start')

    releaseFirst()
    await Promise.all([first, second, label])
    expect(events.indexOf('receipt-2-start')).toBeGreaterThan(events.indexOf('receipt-1-end'))
  })

  it('rejects a timed-out stage and invokes cancellation', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const result = withPrintTimeout(new Promise<never>(() => {}), 100, 'PRINT_STAGE_TIMEOUT', cancel)
    const rejection = expect(result).rejects.toThrow('PRINT_STAGE_TIMEOUT')
    await vi.advanceTimersByTimeAsync(100)
    await rejection
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('keeps POS-58 and POS-80 roles strictly separated', () => {
    expect(() => assertPrinterRole('XPrinter POS-58', 'receipt')).not.toThrow()
    expect(() => assertPrinterRole('XPrinter POS-80', 'label')).not.toThrow()
    expect(() => assertPrinterRole('HPRT N31', 'label')).not.toThrow()
    expect(() => assertPrinterRole('XPrinter POS-80', 'receipt')).toThrow('PRINT_RECEIPT_PRINTER_MISMATCH')
    expect(() => assertPrinterRole('XPrinter POS-58', 'label')).toThrow('PRINT_LABEL_PRINTER_MISMATCH')
  })
})

