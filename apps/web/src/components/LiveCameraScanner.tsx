import { useEffect, useRef, useState } from 'react'
import { Camera, CameraOff, Flashlight, FlashlightOff } from 'lucide-react'
import {
  CAMERA_FORMATS, LIVE_CAMERA_STATE_EVENT, LIVE_CAMERA_STORAGE_KEY, LIVE_CAMERA_TOGGLE_EVENT,
  createScanGate, deliverCameraScan, liveCameraStoredOn, pickBackCamera,
} from '@/lib/cameraScan'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'

type Found = Array<{ rawValue: string }>
type NativeDetector = { detect(source: CanvasImageSource): Promise<Found> }
type DetectorCtor = { new(options: { formats: string[] }): NativeDetector; getSupportedFormats?: () => Promise<string[]> }
/** Можливості камери, яких ще немає в типах браузера: ліхтарик, наближення, режим фокуса. */
type CameraAbilities = MediaTrackCapabilities & { torch?: boolean; zoom?: { min: number; max: number }; focusMode?: string[] }

const SCAN_EVERY_MS = 50
const TORCH_KEY = 'forsage:live-camera:torch'
const FLASH_MS = 700

/**
 * Один звуковий пристрій на весь час роботи. 26.11.2026: на iPhone звук, створений не під час натискання, мовчить —
 * тому пристрій створюється й «будиться» в момент натискання кнопки камери, а сигнал лише грає через нього.
 */
let audio: AudioContext | null = null
function wakeAudio() {
  try {
    const Audio = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Audio) return
    audio ??= new Audio()
    if (audio.state === 'suspended') void audio.resume().catch(() => undefined)
  } catch { /* звук необов'язковий */ }
}
function beep() {
  try { navigator.vibrate?.(40) } catch { /* optional */ }
  try {
    wakeAudio()
    if (!audio) return
    const tone = audio.createOscillator(), gain = audio.createGain()
    tone.frequency.value = 1320; gain.gain.value = 0.12
    tone.connect(gain); gain.connect(audio.destination)
    tone.start(); tone.stop(audio.currentTime + 0.09)
  } catch { /* звук необов'язковий */ }
}

/**
 * Постійний сканер камерою для вебу (план B1, 23.11.2026). Не вікно поверх екрана: без картинки камери
 * (26.11.2026 — смужку прибрано), курсор лишається в полі. Вмикається один раз і працює на всіх екранах, доки не вимкнуть.
 * Вмикається кнопкою внизу ліворуч або значком камери біля поля пошуку (LiveCameraButton, 25.11.2026).
 * Читає вбудованим розпізнавачем телефона (BarcodeDetector), а де його немає (iPhone) — zxing у WebAssembly
 * (25.11.2026); стара бібліотека — лише запасний шлях.
 *
 * 26.11.2026, слово власника: «зчитує через раз, дуже погано розпізнає; на сканері щоразу загоряється ліхтарик — може,
 * і тут додати; хочу швидкість, як у сканера; на айфоні три камери — може, вона міняє фокус, вибрати одну».
 *  — камера: «потрійна»/«подвійна ширококутна» задня (сама переходить на макро зблизька), а не одна ширококутна, яка
 *    зблизька не фокусується; 1920×1080; постійний автофокус; на одиночній камері — наближення ×2 (тримати далі — різкіше);
 *  — розпізнавання без зменшення кадру: по черзі середина кадру в повній різкості і весь кадр;
 *  — кнопка ліхтарика (де телефон дозволяє) — запамʼятовується; зелений спалах кнопки й звук на кожне зчитування.
 */
export function LiveCameraScanner() {
  const [enabled, setEnabled] = useState(liveCameraStoredOn)
  const [state, setState] = useState<'idle' | 'starting' | 'on' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [flash, setFlash] = useState(false)
  const [torchAble, setTorchAble] = useState(false)
  const [torch, setTorch] = useState(() => { try { return localStorage.getItem(TORCH_KEY) === 'on' } catch { return false } })
  const videoRef = useRef<HTMLVideoElement>(null)
  const fallbackRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<MediaStreamTrack | null>(null)
  const signedIn = useAuthStore(store => Boolean(store.session))
  // Телефон чи планшет (палець, а не миша). На ПК кнопка не потрібна: там USB-сканер.
  const touch = typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)').matches)

  useEffect(() => {
    const toggle = () => { wakeAudio(); setEnabled(value => !value) }
    window.addEventListener(LIVE_CAMERA_TOGGLE_EVENT, toggle)
    return () => window.removeEventListener(LIVE_CAMERA_TOGGLE_EVENT, toggle)
  }, [])

  // Ліхтарик: вмикається на камері, що вже працює; вибір памʼятається.
  useEffect(() => {
    try { localStorage.setItem(TORCH_KEY, torch ? 'on' : 'off') } catch { /* optional */ }
    const track = trackRef.current
    if (track && torchAble) void track.applyConstraints({ advanced: [{ torch } as MediaTrackConstraintSet] }).catch(() => undefined)
  }, [torch, torchAble, state])

  useEffect(() => {
    try { sessionStorage.setItem(LIVE_CAMERA_STORAGE_KEY, enabled ? 'on' : 'off') } catch { /* optional */ }
    window.dispatchEvent(new CustomEvent(LIVE_CAMERA_STATE_EVENT, { detail: { on: enabled } }))
    if (!enabled) { setState('idle'); setMessage(''); setTorchAble(false); return }
    let stopped = false
    let stream: MediaStream | null = null
    let timer: number | null = null
    let flashTimer: number | null = null
    let library: { stop(): Promise<void>; clear(): void } | null = null
    const gate = createScanGate()
    const accept = (raw: string) => {
      const code = gate(raw)
      if (!code || stopped) return
      beep()
      setFlash(true)
      if (flashTimer !== null) window.clearTimeout(flashTimer)
      flashTimer = window.setTimeout(() => setFlash(false), FLASH_MS)
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
    const closeCamera = () => { stream?.getTracks().forEach(track => track.stop()); stream = null; trackRef.current = null }
    const size = { width: { ideal: 1920 }, height: { ideal: 1080 } }

    async function openCamera(): Promise<HTMLVideoElement | null> {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, ...size }, audio: false })
      if (stopped) { closeCamera(); return null }
      // Назви камер видно лише після дозволу. Якщо є «потрійна»/«подвійна ширококутна» задня — переходимо на неї.
      let multi = false
      try {
        const better = pickBackCamera(await navigator.mediaDevices.enumerateDevices())
        const current = stream.getVideoTracks()[0]?.getSettings().deviceId
        if (better && better !== current) {
          const next = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: better }, ...size }, audio: false })
          stream.getTracks().forEach(track => track.stop())
          stream = next
        }
        multi = Boolean(better)
      } catch { /* лишаємось на камері за замовчуванням */ }
      if (stopped) { closeCamera(); return null }
      const track = stream.getVideoTracks()[0] ?? null
      trackRef.current = track
      try {
        const abilities = (track?.getCapabilities?.() ?? {}) as CameraAbilities
        const advanced: Array<Record<string, unknown>> = []
        if (abilities.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' })
        // Одна ширококутна камера зблизька не фокусується: наближення ×2 — телефон тримають далі, код різкий.
        if (!multi && abilities.zoom && abilities.zoom.max >= 2) advanced.push({ zoom: Math.max(abilities.zoom.min, 2) })
        if (advanced.length) await track?.applyConstraints({ advanced: advanced as MediaTrackConstraintSet[] }).catch(() => undefined)
        setTorchAble(Boolean(abilities.torch))
      } catch { setTorchAble(false) }
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
     * 26.11.2026: картинки камери на екрані немає, тож код може бути будь-де в кадрі. По черзі: середина кадру
     * БЕЗ зменшення (дрібні штрихи лишаються різкими) і весь кадр — теж без зменшення (проба 26.11: зменшений до 1280 кадр не читав код біля краю).
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
      let turn = 0
      scanLoop(video, source => {
        const width = source.videoWidth, height = source.videoHeight
        if (!width || !height) return Promise.resolve([])
        turn += 1
        if (turn % 2) {
          const cropWidth = Math.round(width * 0.8), cropHeight = Math.round(height * 0.5)
          canvas.width = cropWidth; canvas.height = cropHeight
          context.drawImage(source, Math.round((width - cropWidth) / 2), Math.round((height - cropHeight) / 2), cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)
        } else {
          const scale = Math.min(1, 1920 / Math.max(width, height))
          canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale)
          context.drawImage(source, 0, 0, canvas.width, canvas.height)
        }
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
      if (flashTimer !== null) window.clearTimeout(flashTimer)
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
      <div data-live-camera-flash={flash ? 'on' : 'off'} style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
        className={`fixed bottom-3 left-3 z-[90] flex max-w-[78vw] items-center gap-1 rounded-full px-1.5 py-1 text-xs text-white shadow transition-colors duration-150 ${flash ? 'bg-emerald-600' : 'bg-gray-900/90'}`}>
        <button type="button" onPointerDown={keepFocus(() => { wakeAudio(); setEnabled(value => !value) })}
          aria-label={enabled ? 'Вимкнути сканер камерою' : 'Увімкнути сканер камерою'} aria-pressed={enabled}
          className={`flex items-center gap-1 rounded-full px-2 py-1 ${enabled ? 'bg-yellow-400 text-black' : ''}`}>
          {enabled ? <Camera size={14} /> : <CameraOff size={14} />}
          {enabled && <span>Сканер</span>}
        </button>
        {enabled && <>
          {torchAble && (
            <button type="button" onPointerDown={keepFocus(() => setTorch(value => !value))} aria-label={torch ? 'Вимкнути ліхтарик' : 'Увімкнути ліхтарик'} aria-pressed={torch}
              data-live-camera-torch={torch ? 'on' : 'off'} className={`rounded-full p-1.5 ${torch ? 'bg-white text-black' : ''}`}>
              {torch ? <Flashlight size={14} /> : <FlashlightOff size={14} />}
            </button>
          )}
          <span role="status" className="max-w-[46vw] truncate px-1 font-mono">
            {state === 'starting' ? 'Підключаємо камеру…' : message || 'Наведіть на штрихкод'}
          </span>
        </>}
      </div>
    </div>
  )
}
