import { useEffect, useRef, useState } from 'react'
import { Camera, CameraOff } from 'lucide-react'
import {
  CAMERA_FORMATS, LIVE_CAMERA_STATE_EVENT, LIVE_CAMERA_STORAGE_KEY, LIVE_CAMERA_TOGGLE_EVENT,
  createScanGate, deliverCameraScan, liveCameraStoredOn,
} from '@/lib/cameraScan'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'

type Found = Array<{ rawValue: string }>
type NativeDetector = { detect(source: CanvasImageSource): Promise<Found> }
type DetectorCtor = { new(options: { formats: string[] }): NativeDetector; getSupportedFormats?: () => Promise<string[]> }

const SCAN_EVERY_MS = 70

function beep() {
  try { navigator.vibrate?.(40) } catch { /* optional */ }
  try {
    const Audio = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Audio) return
    const context = new Audio(), tone = context.createOscillator(), gain = context.createGain()
    tone.frequency.value = 1320; gain.gain.value = 0.08
    tone.connect(gain); gain.connect(context.destination)
    tone.start(); tone.stop(context.currentTime + 0.08)
    tone.onended = () => { void context.close() }
  } catch { /* звук необов'язковий */ }
}

/**
 * Постійний сканер камерою для вебу (план B1, 23.11.2026). Не вікно поверх екрана: без картинки камери (26.11.2026 — смужку прибрано)
 * (згортається до значка), курсор лишається в полі. Вмикається один раз і працює на всіх екранах, доки не вимкнуть.
 * Вмикається кнопкою внизу ліворуч або значком камери біля поля пошуку (LiveCameraButton, 25.11.2026).
 * Читає вбудованим розпізнавачем телефона (BarcodeDetector), а де його немає (iPhone) — zxing у WebAssembly
 * (25.11.2026); стара бібліотека — лише запасний шлях.
 */
export function LiveCameraScanner() {
  const [enabled, setEnabled] = useState(liveCameraStoredOn)
  const [state, setState] = useState<'idle' | 'starting' | 'on' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const fallbackRef = useRef<HTMLDivElement>(null)
  const signedIn = useAuthStore(store => Boolean(store.session))
  // Телефон чи планшет (палець, а не миша). На ПК кнопка не потрібна: там USB-сканер.
  const touch = typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)').matches)

  useEffect(() => {
    const toggle = () => setEnabled(value => !value)
    window.addEventListener(LIVE_CAMERA_TOGGLE_EVENT, toggle)
    return () => window.removeEventListener(LIVE_CAMERA_TOGGLE_EVENT, toggle)
  }, [])

  useEffect(() => {
    try { sessionStorage.setItem(LIVE_CAMERA_STORAGE_KEY, enabled ? 'on' : 'off') } catch { /* optional */ }
    window.dispatchEvent(new CustomEvent(LIVE_CAMERA_STATE_EVENT, { detail: { on: enabled } }))
    if (!enabled) { setState('idle'); setMessage(''); return }
    let stopped = false
    let stream: MediaStream | null = null
    let timer: number | null = null
    let library: { stop(): Promise<void>; clear(): void } | null = null
    const gate = createScanGate()
    const accept = (raw: string) => {
      const code = gate(raw)
      if (!code || stopped) return
      beep()
      const outcome = deliverCameraScan(code)
      setMessage(outcome === 'nowhere' ? `${code} — поставте курсор у поле` : code)
    }
    const fail = (error: unknown) => {
      if (stopped) return
      setState('error')
      setMessage(error instanceof Error && /permission|notallowed|denied/i.test(error.name + error.message)
        ? 'Доступ до камери заборонено. Дозвольте камеру в налаштуваннях браузера.'
        : 'Камера недоступна на цьому пристрої.')
    }
    const closeCamera = () => { stream?.getTracks().forEach(track => track.stop()); stream = null }

    async function openCamera(): Promise<HTMLVideoElement | null> {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      if (stopped) { closeCamera(); return null }
      const video = videoRef.current
      if (!video) return null
      video.srcObject = stream
      await video.play().catch(() => undefined)
      return video
    }

    /** Кадр за кадром: поки попереднє розпізнавання не скінчилось, новий кадр не беремо (телефон не захлинається). */
    function scanLoop(video: HTMLVideoElement, read: (video: HTMLVideoElement) => Promise<Found>) {
      let busy = false
      timer = window.setInterval(() => {
        if (busy || stopped || video.readyState < 2) return
        busy = true
        void read(video).then(found => { for (const item of found) accept(item.rawValue) }, () => undefined).finally(() => { busy = false })
      }, SCAN_EVERY_MS)
      setState('on')
    }

    async function startNative(Detector: DetectorCtor): Promise<boolean> {
      const supported = await Detector.getSupportedFormats?.().catch(() => null)
      const formats = supported ? CAMERA_FORMATS.filter(format => supported.includes(format)) : [...CAMERA_FORMATS]
      if (!formats.length) return false
      const video = await openCamera()
      if (!video) return stopped
      const detector = new Detector({ formats })
      scanLoop(video, source => detector.detect(source))
      return true
    }

    /**
     * Без вбудованого розпізнавача (iPhone): zxing у WebAssembly. Камера й розпізнавач готуються одночасно.
     * Розпізнаємо лише смугу посередині кадру (там червона лінія) і зменшену до 960 точок — швидше відповідь.
     */
    async function startZxing(): Promise<boolean> {
      const [detector, video] = await Promise.all([
        import('@/lib/zxingDetector').then(module => module.createZxingDetector(CAMERA_FORMATS)),
        openCamera(),
      ])
      if (!video) return stopped
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) return false
      scanLoop(video, source => {
        const width = source.videoWidth, height = source.videoHeight
        if (!width || !height) return Promise.resolve([])
        const band = Math.round(height * 0.45)
        const scale = Math.min(1, 960 / width)
        canvas.width = Math.round(width * scale); canvas.height = Math.round(band * scale)
        context.drawImage(source, 0, Math.round((height - band) / 2), width, band, 0, 0, canvas.width, canvas.height)
        return detector.detect(canvas)
      })
      return true
    }

    async function startLibrary() {
      const { Html5Qrcode, Html5QrcodeSupportedFormats: F } = await import('html5-qrcode')
      if (stopped || !fallbackRef.current) return
      const scanner = new Html5Qrcode(fallbackRef.current.id, { formatsToSupport: [F.EAN_13, F.EAN_8, F.CODE_128, F.CODE_39, F.UPC_A, F.UPC_E, F.QR_CODE], verbose: false })
      library = scanner
      await scanner.start({ facingMode: 'environment' }, { fps: 15 }, (text: string) => accept(text), () => undefined)
      if (stopped) { await scanner.stop().catch(() => undefined); return }
      setState('on')
    }

    setState('starting'); setMessage('')
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera')
        const Detector = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector
        if (Detector && await startNative(Detector)) return
        if (stopped) return
        let zxingError: unknown = null
        const zxingStarted = await startZxing().catch(error => { zxingError = error; return false })
        if (zxingStarted || stopped) return
        // Камеру заборонили — запасна бібліотека не допоможе, кажемо одразу.
        if (zxingError instanceof Error && /permission|notallowed|denied/i.test(zxingError.name + zxingError.message)) throw zxingError
        closeCamera()
        await startLibrary()
      } catch (error) { fail(error) }
    })()

    return () => {
      stopped = true
      if (timer !== null) window.clearInterval(timer)
      closeCamera()
      if (library) { const scanner = library; void scanner.stop().catch(() => undefined).finally(() => { try { scanner.clear() } catch { /* already cleared */ } }) }
    }
  }, [enabled])

  // Кнопки не забирають курсор із поля вводу: дія на pointerdown з preventDefault.
  const keepFocus = (action: () => void) => (event: React.PointerEvent) => { event.preventDefault(); action() }

  if (isDesktopRuntime() || !signedIn || !(touch || enabled)) return null
  return (
    <div className="print:hidden" data-live-camera={state}>
      {/* 26.11.2026, слово власника: «вузька смужка камери вгорі некрасива й не потрібна — не хочу бачити, що знімаю;
          досить, щоб швидко вловила й зчитала штрихкод». Відео грає, але невидиме (2×2 точки, прозоре): браузер
          розпізнає кадр у повному розмірі камери, а на екрані нічого не зʼявляється. display:none не годиться —
          тоді телефон зупиняє відео. */}
      {enabled && (
        <div aria-hidden="true" data-live-camera-hidden className="pointer-events-none fixed left-0 top-0 z-0 h-[2px] w-[2px] overflow-hidden opacity-[0.01]">
          <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
          <div id="live-camera-fallback" ref={fallbackRef} className="absolute inset-0 [&_video]:h-full [&_video]:w-full [&_video]:object-cover" />
        </div>
      )}
      <div className="fixed bottom-3 left-3 z-[90] flex max-w-[70vw] items-center gap-1 rounded-full bg-gray-900/90 px-1.5 py-1 text-xs text-white shadow" style={{ marginBottom: 'env(safe-area-inset-bottom)' }}>
        <button type="button" onPointerDown={keepFocus(() => setEnabled(value => !value))}
          aria-label={enabled ? 'Вимкнути сканер камерою' : 'Увімкнути сканер камерою'} aria-pressed={enabled}
          className={`flex items-center gap-1 rounded-full px-2 py-1 ${enabled ? 'bg-yellow-400 text-black' : ''}`}>
          {enabled ? <Camera size={14} /> : <CameraOff size={14} />}
          {enabled && <span>Сканер</span>}
        </button>
        {enabled && <>
          <span role="status" className="max-w-[46vw] truncate px-1 font-mono">
            {state === 'starting' ? 'Підключаємо камеру…' : message || 'Наведіть на штрихкод'}
          </span>
        </>}
      </div>
    </div>
  )
}
