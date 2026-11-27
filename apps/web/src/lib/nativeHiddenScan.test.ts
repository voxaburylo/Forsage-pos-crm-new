import { beforeEach, describe, expect, it, vi } from 'vitest'

// 27.11.2026, слово власника: «камера мені не потрібна — треба прямо в рядку, як на справжньому сканері».
// Невидимий режим не ховає екран програми, вмикає ліхтарик і віддає код; після коду камера й ліхтарик вимкнені.
const plugin = vi.hoisted(() => ({
  calls: [] as string[],
  permission: 'granted',
  torch: true,
  onScan: null as null | ((event: { barcodes: Array<{ rawValue?: string }> }) => void),
}))

vi.mock('@capacitor-mlkit/barcode-scanning', () => ({
  BarcodeScanner: {
    checkPermissions: async () => ({ camera: plugin.permission }),
    requestPermissions: async () => ({ camera: plugin.permission }),
    addListener: async (_name: string, callback: typeof plugin.onScan) => { plugin.onScan = callback; return { remove: async () => { plugin.calls.push('remove') } } },
    startScan: async () => { plugin.calls.push('startScan') },
    stopScan: async () => { plugin.calls.push('stopScan') },
    isTorchAvailable: async () => ({ available: plugin.torch }),
    enableTorch: async () => { plugin.calls.push('enableTorch') },
    disableTorch: async () => { plugin.calls.push('disableTorch') },
  },
}))

import { CameraDenied, startHiddenScan } from './nativeCamera'

describe('hidden phone scanner: the code goes straight into the line, the screen stays', () => {
  beforeEach(() => { plugin.calls = []; plugin.permission = 'granted'; plugin.torch = true; plugin.onScan = null })

  it('starts the camera with the torch, gives the first code and switches everything off', async () => {
    const scan = await startHiddenScan()
    // Тест іде без document: невидимий режим екрана програми не торкається (не ховає його й не додає рамку).
    expect(typeof globalThis.document).toBe('undefined')
    expect(plugin.calls).toEqual(['startScan', 'enableTorch'])
    plugin.onScan?.({ barcodes: [{ rawValue: '' }, { rawValue: ' 4820000000s15 ' }] })
    await expect(scan.done).resolves.toBe('4820000000s15')
    expect(plugin.calls).toEqual(expect.arrayContaining(['remove', 'disableTorch', 'stopScan']))
  })

  it('works without a torch and can be cancelled', async () => {
    plugin.torch = false
    const scan = await startHiddenScan()
    expect(plugin.calls).not.toContain('enableTorch')
    scan.cancel()
    await expect(scan.done).resolves.toBeNull()
    expect(plugin.calls).toContain('stopScan')
  })

  it('without camera permission says so and does not start', async () => {
    plugin.permission = 'denied'
    await expect(startHiddenScan()).rejects.toBeInstanceOf(CameraDenied)
    expect(plugin.calls).toEqual([])
  })
})
