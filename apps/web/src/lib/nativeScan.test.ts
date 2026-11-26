import { afterEach, describe, expect, it } from 'vitest'
import { firstCode, isNativeApp, isScanCancel, nativeFormats } from './nativeScan'

// 27.11.2026: у застосунку на телефоні «курок» сканера відкриває рідний сканер телефона; у браузері — нічого не міняється.
describe('the phone’s own scanner in the app', () => {
  afterEach(() => { delete (globalThis as { Capacitor?: unknown }).Capacitor })

  it('only inside the app; a browser is not the app', () => {
    expect(isNativeApp()).toBe(false)
    ;(globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => false }
    expect(isNativeApp()).toBe(false)
    ;(globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true }
    expect(isNativeApp()).toBe(true)
  })

  it('the same barcode kinds as in the web scanner', () => {
    expect(nativeFormats()).toEqual(['EAN_13', 'EAN_8', 'CODE_128', 'CODE_39', 'UPC_A', 'UPC_E', 'QR_CODE'])
  })

  it('the first non-empty code is taken; closing the scanner is not an error', () => {
    expect(firstCode([{ rawValue: '' }, { rawValue: ' 4820000000123 ' }, { rawValue: 'other s' }])).toBe('4820000000123')
    expect(firstCode([{ displayValue: 'W712 s' }])).toBe('W712 s')
    expect(firstCode([])).toBeNull()
    expect(firstCode(null)).toBeNull()
    expect(isScanCancel(new Error('scan canceled.'))).toBe(true)
    expect(isScanCancel(new Error('Camera unavailable'))).toBe(false)
  })
})
