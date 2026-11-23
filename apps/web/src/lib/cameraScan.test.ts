import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CAMERA_REPEAT_MS, createScanGate, deliverCameraScan, scanTargetField } from './cameraScan'

// 23.11.2026 (план B1), слово власника: «швидке зчитування штрихкодів у вебі з телефона через камеру; не треба
// відкривати картинку, увага лишається в полі вводу, моментальне зчитування».
describe('camera scan gate', () => {
  it('passes a code once while the camera keeps seeing it, and again after a pause or for another code', () => {
    let now = 1000
    const gate = createScanGate(() => now)
    expect(gate(' 4820000123456 ')).toBe('4820000123456')
    now += 300; expect(gate('4820000123456')).toBeNull()
    now += 300; expect(gate('4006381333931')).toBe('4006381333931')
    now += CAMERA_REPEAT_MS; expect(gate('4006381333931')).toBe('4006381333931')
    expect(gate('')).toBeNull()
    expect(gate('x'.repeat(201))).toBeNull()
  })
})

describe('where a camera code goes', () => {
  // Без браузера: вікно й поле — прості об'єкти з тією самою поведінкою.
  function page(active: Record<string, unknown> | null, onScan?: (event: Event) => void) {
    return { document: { activeElement: active }, dispatchEvent: (event: Event) => { onScan?.(event); return !event.defaultPrevented } } as never
  }
  function field(over: Record<string, unknown> = {}) {
    const events: string[] = []
    const value = { tagName: 'INPUT', type: 'text', value: 'old', dispatchEvent: (event: Event) => { events.push(event.type + (event.type === 'input' ? ':' + value.value : ':' + (event as unknown as { key: string }).key)); return true }, ...over }
    return { value, events }
  }

  it('a screen with the till scanner takes the code itself; nothing is typed into the field', () => {
    const { value, events } = field()
    const seen: string[] = []
    expect(deliverCameraScan('4820000123456', page(value, event => { seen.push((event as CustomEvent).detail.code); event.preventDefault() }))).toBe('screen')
    expect(seen).toEqual(['4820000123456'])
    expect(events).toEqual([])
    expect(value.value).toBe('old')
  })

  it('otherwise it lands in the field with the cursor, followed by Enter — like a USB scanner', () => {
    const { value, events } = field()
    expect(deliverCameraScan('4820000123456', page(value))).toBe('field')
    expect(events).toEqual(['input:4820000123456', 'keydown:Enter', 'keyup:Enter'])
  })

  it('never types into a password, a read-only field or a button', () => {
    expect(scanTargetField(field({ type: 'password' }).value)).toBeNull()
    expect(scanTargetField(field({ readOnly: true }).value)).toBeNull()
    expect(scanTargetField(field({ disabled: true }).value)).toBeNull()
    expect(scanTargetField(field({ tagName: 'BUTTON' }).value)).toBeNull()
    expect(scanTargetField(field({ tagName: 'TEXTAREA', type: undefined }).value)).not.toBeNull()
    expect(deliverCameraScan('4820000123456', page(field({ tagName: 'BUTTON' }).value))).toBe('nowhere')
    expect(deliverCameraScan('4820000123456', page(null))).toBe('nowhere')
  })
})

describe('wiring of the live camera scanner', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

  it('one scanner for the whole web app; the till scanner hook listens to it', () => {
    expect(read('../App.tsx')).toContain('<LiveCameraScanner />')
    const hook = read('../features/pos/usePOSBarcodeScanner.ts')
    expect(hook).toContain('window.addEventListener(CAMERA_SCAN_EVENT, handleCameraScan)')
    expect(hook).toContain('if (ownsScan(document.activeElement)) return')
  })

  it('is not a window over the screen and does not take the cursor away', () => {
    const scanner = read('../components/LiveCameraScanner.tsx')
    expect(scanner).toContain('BarcodeDetector')
    expect(scanner).toContain("await import('html5-qrcode')")
    expect(scanner).toContain('event.preventDefault(); action()')
    expect(scanner).toContain('if (isDesktopRuntime() || !signedIn || !(touch || enabled)) return null')
    expect(scanner).not.toContain('inset-0 z-[100]')
  })
})
