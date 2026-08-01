import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrintService } from './printService'

describe('PrintService native lock', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not expire while the native driver job is still alive', async () => {
    vi.useFakeTimers()
    let finish!: (value: { success: true }) => void
    const nativePrint = vi.fn(() => new Promise<{ success: true }>((resolve) => { finish = resolve }))
    const previousWindow = globalThis.window
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { forsageDesktop: { print: { html: nativePrint } } },
    })

    const options = {
      preferDesktopNative: true,
      pageSizeMm: { width: 40, height: 30 },
      deviceName: 'POS-80',
      strictPageSize: true,
    }

    try {
      const first = PrintService.printHtmlAndWait('<html></html>', options)
      await Promise.resolve()
      expect(nativePrint).toHaveBeenCalledTimes(1)

      await expect(PrintService.printHtmlAndWait('<html></html>', options))
        .rejects.toThrow('Попереднє вікно друку ще відкрите')
      vi.advanceTimersByTime(5 * 60_000)
      await expect(PrintService.printHtmlAndWait('<html></html>', options))
        .rejects.toThrow('Попереднє вікно друку ще відкрите')

      finish({ success: true })
      await first
      expect(nativePrint.mock.calls[0]?.[1]).toMatchObject({
        deviceName: 'POS-80',
        printerRole: 'label',
      })
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    }
  })
})

