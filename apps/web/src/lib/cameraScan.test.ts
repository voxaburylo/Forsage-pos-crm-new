import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SCAN_HOLD_MS, SCAN_SESSION_MS, deliverCameraScan, pickBackCamera, scanTargetField, triggerOnPress, triggerOnRelease } from './cameraScan'
import { frameRegion } from './cameraReader'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// 23.11.2026 (план B1), слово власника: «швидке зчитування штрихкодів у вебі з телефона через камеру; не треба
// відкривати картинку, увага лишається в полі вводу, моментальне зчитування».
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

  it('with the cursor outside any field the code goes to the search field of the screen', () => {
    const typed: string[] = []
    const search = { tagName: 'INPUT', type: 'text', value: '', dispatchEvent: (event: Event) => { typed.push(event.type); return true } }
    const doc = { activeElement: { tagName: 'BODY' }, querySelector: (selector: string) => selector === '[data-scan-field]' ? search : null }
    expect(deliverCameraScan('4820000123456', { document: doc, dispatchEvent: () => true } as never)).toBe('field')
    expect(search.value).toBe('4820000123456')
    expect(typed).toEqual(['input', 'keydown', 'keyup'])
    expect(deliverCameraScan('4820000123456', { document: { activeElement: null, querySelector: () => null }, dispatchEvent: () => true } as never)).toBe('nowhere')
    for (const file of ['../features/pos/SearchPanel.tsx', '../features/products/ProductsPage.tsx', '../features/inventory/ActiveSession.tsx']) expect(read(file), file).toContain('data-scan-field')
  })
})

/**
 * 26.11.2026, слово власника: «біля рядка вводу штрихкоду — значок сканера, і як на сканері: на ньому ж є кнопка, камера
 * не чекає постійно й дозвіл не висить постійно. Натиснув — буквально за секунду камера зчитала штрихкод, зі спалахом
 * одночасно. Щойно штрихкод виявлено й зчитано — автоматично вимикається. Максимально яскраво й зрозуміло».
 */
describe('the scanner works like the trigger of a hand scanner', () => {
  const scanner = read('../components/LiveCameraScanner.tsx'), button = read('../components/LiveCameraButton.tsx')

  it('press starts a scan, press during a scan cancels it; a held trigger stops on release, a short tap keeps waiting for the code', () => {
    expect(triggerOnPress('idle')).toBe('start')
    expect([triggerOnPress('starting'), triggerOnPress('scanning')]).toEqual(['cancel', 'cancel'])
    expect(triggerOnRelease(true, SCAN_HOLD_MS)).toBe('stop')
    expect(triggerOnRelease(true, 3000)).toBe('stop')
    expect(triggerOnRelease(true, SCAN_HOLD_MS - 1)).toBe('keep')
    // Натискання, що скасувало попереднє сканування, на відпусканні вже нічого не зупиняє.
    expect(triggerOnRelease(false, 3000)).toBe('keep')
    expect(SCAN_SESSION_MS).toBeGreaterThanOrEqual(5000)
    expect(button).toContain("if (triggerOnPress(phaseRef.current) === 'cancel')")
    expect(button).toContain("triggerOnRelease(current.started, Date.now() - current.at) === 'stop'")
  })

  it('the camera never stays on: every way out of a scan stops the camera tracks', () => {
    // Єдине місце, де сканування закінчується, — stop(): зчитано, відпустили, скасували, час вийшов, помилка, екран закрили.
    expect(scanner).toContain("stream?.getTracks().forEach(track => track.stop()); stream = null")
    expect(scanner).toContain("stop('read')")
    expect(scanner).toContain("deadline = window.setTimeout(() => stop('timeout'), SCAN_SESSION_MS)")
    expect(scanner).toContain("stop('error')")
    expect(scanner).toContain("const hidden = () => { if (document.hidden) session.current?.stop('cancel') }")
    expect(scanner).toContain("session.current?.stop('cancel')\n    }\n  }, [off])")
    // Камеру, яку телефон дав уже після зупинки (натиснув і одразу відпустив), теж відпускаємо.
    expect(scanner.match(/if \(stopped\) \{ release\(\); return \}/g)?.length).toBeGreaterThanOrEqual(3)
    // Нічого «постійного»: ні памʼяті «увімкнено», ні автозапуску при відкритті сторінки.
    expect(scanner).not.toContain('sessionStorage')
    expect(scanner).not.toContain('setEnabled')
    expect(read('./cameraScan.ts')).not.toContain('liveCameraStoredOn')
  })

  it('the torch comes on together with the camera and one code ends the scan', () => {
    expect(scanner).toContain('if (abilities.torch) settings.torch = true')
    expect(scanner).toContain("if (abilities.focusMode?.includes('continuous')) settings.focusMode = 'continuous'")
    expect(scanner).toContain('if (!multi && abilities.zoom && abilities.zoom.max >= 2) settings.zoom = Math.max(abilities.zoom.min, 2)')
    expect(scanner).toContain('width: { ideal: 1920 }, height: { ideal: 1080 }')
    const readAt = scanner.indexOf('beep()\n          const outcome = deliverCameraScan(code)')
    expect(readAt).toBeGreaterThan(0)
    expect(scanner.indexOf("stop('read')", readAt)).toBeGreaterThan(readAt)
    // Звук працює на iPhone: звуковий пристрій «будиться» в мить натискання.
    expect(scanner).toContain('wakeAudio()\n      session.current = runScanSession(video')
  })

  it('bright and clear: scanner icon, yellow and pulsing while it looks, green with a tick when read', () => {
    expect(button).toContain("import { Check, ScanBarcode } from 'lucide-react'")
    expect(button).toContain("read ? '!bg-emerald-500 !text-white !border-emerald-500' : busy ? '!bg-yellow-400 !text-black !border-yellow-400 animate-pulse' : ''")
    expect(button).toContain('{read ? <Check size={size} strokeWidth={3} /> : <ScanBarcode size={size} />}')
    expect(scanner).toContain("toast.warning('Штрихкод не зчитано. Піднесіть телефон ближче до коду й натисніть сканер ще раз.')")
  })

  it('does not take the cursor away, does not scroll or select text under a held finger; hidden in the PC program', () => {
    expect(button).toContain('onPointerDown={event => { event.preventDefault();')
    expect(button).toContain("style={{ touchAction: 'none', WebkitTouchCallout: 'none', userSelect: 'none', WebkitUserSelect: 'none' }}")
    expect(button).toContain('onContextMenu={event => event.preventDefault()}')
    expect(button).toContain('if (desktop) return null')
    expect(scanner).toContain('const off = isDesktopRuntime() || !signedIn')
  })

  it('no floating switch and no camera picture: only an invisible video (not display:none, which stops it on phones)', () => {
    expect(scanner).not.toContain('<button')
    expect(scanner).not.toContain('fixed bottom-3 left-3')
    expect(scanner).toContain('h-[2px] w-[2px] overflow-hidden opacity-[0.01]')
    expect(scanner).not.toMatch(/<video[^>]*className="[^"]*hidden/)
  })

  it('one scanner for the whole web app; the three search screens have the trigger and take the code like a USB scan', () => {
    expect(read('../App.tsx')).toContain('<LiveCameraScanner />')
    const hook = read('../features/pos/usePOSBarcodeScanner.ts')
    expect(hook).toContain('window.addEventListener(CAMERA_SCAN_EVENT, handleCameraScan)')
    for (const screen of ['../features/pos/SearchPanel.tsx', '../features/products/ProductsPage.tsx', '../features/inventory/ActiveSession.tsx']) {
      expect(read(screen), screen).toContain('<LiveCameraButton')
      expect(read(screen), screen).not.toContain('CameraScanner')
    }
    for (const screen of ['../features/pos/POSPage.tsx', '../features/products/ProductsPage.tsx', '../features/inventory/ActiveSession.tsx']) expect(read(screen), screen).toContain('usePOSBarcodeScanner(')
  })
})

describe('fast and sharp reading', () => {
  it('the reader is prepared before the first press and reused; iPhone uses zxing WebAssembly from our own site', () => {
    const reader = read('./cameraReader.ts')
    expect(read('../components/LiveCameraButton.tsx')).toContain('useEffect(() => { if (!desktop) warmCameraReader() }, [desktop])')
    expect(reader).toContain('reader ??= (async () => (await nativeReader().catch(() => null)) ?? await zxingReader())()')
    expect(reader).toContain('reader.catch(() => { reader = null })')
    expect(read('../components/LiveCameraScanner.tsx')).toContain('const [read] = await Promise.all([cameraFrameReader(), openCamera()])')
    const zxing = read('./zxingDetector.ts')
    expect(zxing).toContain("from 'zxing-wasm/reader/zxing_reader.wasm?url'")
    expect(zxing).toContain('fireImmediately: true')
    expect(zxing).not.toMatch(/jsdelivr|unpkg/)
  })

  // Проба 26.11.2026 (camera-decode-smoke): стара смуга, зменшена до 960 точок, читала 1 код із 6; без зменшення — 6 з 6.
  it('frames are never downscaled: the centre of the frame and the whole frame take turns', () => {
    expect(frameRegion(1920, 1080, 1)).toEqual({ sx: 192, sy: 270, sw: 1536, sh: 540, width: 1536, height: 540 })
    expect(frameRegion(1920, 1080, 2)).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080, width: 1920, height: 1080 })
    expect(frameRegion(1280, 720, 4)).toEqual({ sx: 0, sy: 0, sw: 1280, sh: 720, width: 1280, height: 720 })
    // Лише кадр, більший за 1920 точок (4K), зменшується — до 1920.
    expect(frameRegion(3840, 2160, 2)).toMatchObject({ width: 1920, height: 1080 })
  })

  it('picks the iPhone back camera that focuses up close (triple, then dual wide), in any system language', () => {
    const cam = (deviceId: string, label: string, kind = 'videoinput') => ({ deviceId, label, kind })
    expect(pickBackCamera([cam('f', 'Front Camera'), cam('w', 'Back Camera'), cam('u', 'Back Ultra Wide Camera'), cam('t', 'Back Telephoto Camera'), cam('d', 'Back Dual Wide Camera'), cam('3', 'Back Triple Camera')])).toBe('3')
    expect(pickBackCamera([cam('w', 'Back Camera'), cam('d', 'Back Dual Wide Camera'), cam('u', 'Back Ultra Wide Camera')])).toBe('d')
    expect(pickBackCamera([cam('w', 'Задняя камера'), cam('3', 'Задняя тройная камера')])).toBe('3')
    expect(pickBackCamera([cam('w', 'Задня камера'), cam('d', 'Задня подвійна ширококутна камера')])).toBe('d')
    // «Подвійна ширококутна» вище за просто «подвійну» (ширококутна + теле) — будь-якою мовою.
    expect(pickBackCamera([cam('t', 'Задняя двойная камера'), cam('d', 'Задняя двойная широкоугольная камера')])).toBe('d')
    expect(pickBackCamera([cam('t', 'Задня подвійна камера'), cam('d', 'Задня подвійна ширококутна камера')])).toBe('d')
    // Одна камера (чи назв ще немає) — лишаємось на камері за замовчуванням.
    expect(pickBackCamera([cam('w', 'Back Camera'), cam('f', 'Front Camera')])).toBeNull()
    expect(pickBackCamera([cam('x', ''), cam('m', 'Back Triple Camera', 'audioinput')])).toBeNull()
  })

  // «камера щоразу питає дозвіл»: програма просила камеру двічі поспіль (звичайну, потім «потрійну»).
  it('asks the phone for the camera once: the camera chosen last time is requested straight away', () => {
    const scanner = read('../components/LiveCameraScanner.tsx')
    expect(scanner).toContain('getUserMedia({ video: { deviceId: { exact: remembered.id }, ...size }, audio: false }); multi = remembered.multi')
    expect(scanner).toContain('rememberCamera(chosen ? { id: chosen, multi } : null)')
    // Відмова в дозволі — не привід просити ще раз іншим шляхом.
    expect(scanner).toContain('catch (error) { if (denied(error)) throw error; rememberCamera(null); stream = null }')
  })
})
