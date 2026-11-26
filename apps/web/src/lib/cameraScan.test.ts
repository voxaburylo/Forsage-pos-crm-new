import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CAMERA_REPEAT_MS, LIVE_CAMERA_STORAGE_KEY, LIVE_CAMERA_TOGGLE_EVENT, createScanGate, deliverCameraScan, liveCameraStoredOn, scanTargetField, toggleLiveCamera } from './cameraScan'

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

  // 26.11.2026, слово власника: «вузька смужка камери вгорі некрасива; не хочу бачити, що знімаю — лише швидко зчитати».
  it('shows no camera picture: the video plays invisibly (not display:none, which stops it on phones)', () => {
    const scanner = read('../components/LiveCameraScanner.tsx')
    expect(scanner).toContain('h-[2px] w-[2px] overflow-hidden opacity-[0.01]')
    expect(scanner).not.toContain('h-24 rounded-b-xl')
    expect(scanner).not.toContain('Згорнути приціл')
    expect(scanner).not.toMatch(/<video[^>]*className="[^"]*hidden/)
  })
})

// 25.11.2026, слово власника: «я пробував, але все одно довго працює і відкривається камера; мені не треба відкривати
// картинку, увага лишається в полі вводу, моментальне зчитування».
describe('camera icon next to the search fields turns on the live scanner, not a picture window', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

  it('toggle is a plain event; the scanner remembers being on for the session', () => {
    const sent: string[] = []
    toggleLiveCamera({ dispatchEvent: (event: Event) => { sent.push(event.type); return true } })
    expect(sent).toEqual([LIVE_CAMERA_TOGGLE_EVENT])
    expect(liveCameraStoredOn({ getItem: key => (key === LIVE_CAMERA_STORAGE_KEY ? 'on' : null) })).toBe(true)
    expect(liveCameraStoredOn({ getItem: () => 'off' })).toBe(false)
    expect(liveCameraStoredOn({ getItem: () => { throw new Error('private mode') } })).toBe(false)
    expect(liveCameraStoredOn(null)).toBe(false)
  })

  it('till, products and stocktaking use the toggle button; the old picture window is gone', () => {
    for (const screen of ['../features/pos/SearchPanel.tsx', '../features/products/ProductsPage.tsx', '../features/inventory/ActiveSession.tsx']) {
      const source = read(screen)
      expect(source, screen).toContain('<LiveCameraButton')
      expect(source, screen).not.toContain('CameraScanner')
    }
    // Код із камери ці екрани приймають тим самим хуком, що й код USB-сканера.
    for (const screen of ['../features/pos/POSPage.tsx', '../features/products/ProductsPage.tsx', '../features/inventory/ActiveSession.tsx']) expect(read(screen), screen).toContain('usePOSBarcodeScanner(')
    const button = read('../components/LiveCameraButton.tsx')
    expect(button).toContain('onPointerDown={event => { event.preventDefault(); toggleLiveCamera() }}')
    expect(button).toContain('if (isDesktopRuntime()) return null')
    expect(read('../components/LiveCameraScanner.tsx')).toContain('window.addEventListener(LIVE_CAMERA_TOGGLE_EVENT, toggle)')
  })

  it('phones without a built-in reader (iPhone) use zxing WebAssembly served by our own site (not a CDN)', () => {
    const scanner = read('../components/LiveCameraScanner.tsx')
    expect(scanner).toContain("import('@/lib/zxingDetector')")
    expect(scanner.indexOf('startNative(Detector)')).toBeLessThan(scanner.indexOf('await startZxing()'))
    expect(scanner.indexOf('await startZxing()')).toBeLessThan(scanner.indexOf('await startLibrary()'))
    const zxing = read('./zxingDetector.ts')
    expect(zxing).toContain("from 'zxing-wasm/reader/zxing_reader.wasm?url'")
    expect(zxing).toContain('fireImmediately: true')
    expect(zxing).not.toMatch(/jsdelivr|unpkg/)
  })
})

// 26.11.2026, слово власника: «зчитує через раз, погано розпізнає; на сканері загоряється ліхтарик — додати; швидкість як
// у сканера; на айфоні три камери — може, вона міняє фокус, вибрати одну, яка більше підходить».
describe('camera reads like a hand scanner', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

  it('a code that stays in view is read once, however long; again only after the camera lost it', async () => {
    const { createScanGate, CAMERA_REPEAT_MS } = await import('./cameraScan')
    let now = 0
    const gate = createScanGate(() => now)
    expect(gate('4820000123456')).toBe('4820000123456')
    for (let i = 0; i < 40; i += 1) { now += 300; expect(gate('4820000123456')).toBeNull() }
    now += CAMERA_REPEAT_MS; expect(gate('4820000123456')).toBe('4820000123456')
  })

  it('picks the iPhone back camera that focuses up close (triple, then dual wide), in any system language', async () => {
    const { pickBackCamera } = await import('./cameraScan')
    const cam = (deviceId: string, label: string, kind = 'videoinput') => ({ deviceId, label, kind })
    expect(pickBackCamera([cam('f', 'Front Camera'), cam('w', 'Back Camera'), cam('u', 'Back Ultra Wide Camera'), cam('t', 'Back Telephoto Camera'), cam('d', 'Back Dual Wide Camera'), cam('3', 'Back Triple Camera')])).toBe('3')
    expect(pickBackCamera([cam('w', 'Back Camera'), cam('d', 'Back Dual Wide Camera'), cam('u', 'Back Ultra Wide Camera')])).toBe('d')
    expect(pickBackCamera([cam('w', 'Задняя камера'), cam('3', 'Задняя тройная камера')])).toBe('3')
    expect(pickBackCamera([cam('w', 'Задня камера'), cam('d', 'Задня подвійна ширококутна камера')])).toBe('d')
    // Одна камера (чи назв ще немає) — лишаємось на камері за замовчуванням.
    expect(pickBackCamera([cam('w', 'Back Camera'), cam('f', 'Front Camera')])).toBeNull()
    expect(pickBackCamera([cam('x', ''), cam('m', 'Back Triple Camera', 'audioinput')])).toBeNull()
  })

  it('full sharpness, steady focus, torch button, green flash and a sound that works on iPhone', () => {
    const scanner = read('../components/LiveCameraScanner.tsx')
    expect(scanner).toContain('width: { ideal: 1920 }, height: { ideal: 1080 }')
    expect(scanner).toContain("advanced.push({ focusMode: 'continuous' })")
    expect(scanner).toContain('if (!multi && abilities.zoom && abilities.zoom.max >= 2)')
    expect(scanner).toContain('pickBackCamera(await navigator.mediaDevices.enumerateDevices())')
    // Середина кадру — без зменшення; старе зменшення до 960 точок прибрано.
    expect(scanner).not.toContain('960 / width')
    expect(scanner).toContain('context.drawImage(source, Math.round((width - cropWidth) / 2), Math.round((height - cropHeight) / 2), cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)')
    expect(scanner).toContain('data-live-camera-torch')
    expect(scanner).toContain("advanced: [{ torch } as MediaTrackConstraintSet]")
    expect(scanner).toContain("flash ? 'bg-emerald-600'")
    // Звук: один пристрій, який «будиться» під час натискання кнопки камери.
    expect(scanner).toContain('onPointerDown={keepFocus(() => { wakeAudio(); setEnabled(value => !value) })}')
    expect(scanner).toContain('const toggle = () => { wakeAudio(); setEnabled(value => !value) }')
  })
})
