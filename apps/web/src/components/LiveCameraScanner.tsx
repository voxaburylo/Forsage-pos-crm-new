import { useEffect, useRef, useState } from 'react'
import { Camera, CameraOff, ChevronDown, ChevronUp } from 'lucide-react'
import { CAMERA_FORMATS, createScanGate, deliverCameraScan } from '@/lib/cameraScan'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'

type NativeDetector = { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> }
type DetectorCtor = { new(options: { formats: string[] }): NativeDetector; getSupportedFormats?: () => Promise<string[]> }

const STORAGE_KEY = 'forsage.camera-scanner'
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
 * Постійний сканер камерою для вебу (план B1, 23.11.2026). Не вікно поверх екрана: вузька смужка-приціл угорі
 * (згортається до значка), курсор лишається в полі. Вмикається один раз і працює на всіх екранах, доки не вимкнуть.
 * Читає вбудованим розпізнавачем телефона (BarcodeDetector), а де його немає (iPhone) — бібліотекою, як і раніше.
 */
export function LiveCameraScanner() {
  const [enabled, setEnabled] = useState(() => { try { return sessionStorage.getItem(STORAGE_KEY) === 'on' } catch { return false } })
  const [collapsed, setCollapsed] = useState(false)
  const [state, setState] = useState<'idle' | 'starting' | 'on' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const fallbackRef = useRef<HTMLDivElement>(null)
  const signedIn = useAuthStore(store => Boolean(store.session))
  // Телефон чи планшет (палець, а не миша). На ПК кнопка не потрібна: там USB-сканер.
  const touch = typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)').matches)

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off') } catch { /* optional */ }
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

    async function startNative(Detector: DetectorCtor) {
      const supported = await Detector.getSupportedFormats?.().catch(() => null)
      const formats = supported ? CAMERA_FORMATS.filter(format => supported.includes(format)) : [...CAMERA_FORMATS]
      if (!formats.length) return false
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      if (stopped) { stream.getTracks().forEach(track => track.stop()); return true }
      const video = videoRef.current
      if (!video) return false
      video.srcObject = stream
      await video.play().catch(() => undefined)
      const detector = new Detector({ formats })
      let busy = false
      timer = window.setInterval(() => {
        if (busy || stopped || video.readyState < 2) return
        busy = true
        void detector.detect(video).then(found => { for (const item of found) accept(item.rawValue) }, () => undefined).finally(() => { busy = false })
      }, SCAN_EVERY_MS)
      setState('on')
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
        await startLibrary()
      } catch (error) { fail(error) }
    })()

    return () => {
      stopped = true
      if (timer !== null) window.clearInterval(timer)
      stream?.getTracks().forEach(track => track.stop())
      if (library) { const scanner = library; void scanner.stop().catch(() => undefined).finally(() => { try { scanner.clear() } catch { /* already cleared */ } }) }
    }
  }, [enabled])

  // Кнопки не забирають курсор із поля вводу: дія на pointerdown з preventDefault.
  const keepFocus = (action: () => void) => (event: React.PointerEvent) => { event.preventDefault(); action() }

  if (isDesktopRuntime() || !signedIn || !(touch || enabled)) return null
  return (
    <div className="print:hidden" data-live-camera={state}>
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[90] flex flex-col items-center">
      {enabled && (
        <div className={`pointer-events-none relative w-full max-w-md overflow-hidden bg-black shadow-lg ${collapsed ? 'h-0' : 'h-24 rounded-b-xl'}`}>
          <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
          <div id="live-camera-fallback" ref={fallbackRef} className="absolute inset-0 [&_video]:h-full [&_video]:w-full [&_video]:object-cover" />
          <div className="absolute inset-x-6 top-1/2 h-0.5 -translate-y-1/2 bg-red-500/80" />
        </div>
      )}
    </div>
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
          <button type="button" onPointerDown={keepFocus(() => setCollapsed(value => !value))} aria-label={collapsed ? 'Показати приціл' : 'Згорнути приціл'} className="rounded-full p-1">
            {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
        </>}
      </div>
    </div>
  )
}
