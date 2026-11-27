import { useEffect, useRef } from 'react'
import {
  LIVE_CAMERA_DEVICE_KEY, SCAN_SESSION_MS, SCAN_TRIGGER_READ_EVENT, SCAN_TRIGGER_START_EVENT, SCAN_TRIGGER_STATE_EVENT, SCAN_TRIGGER_STOP_EVENT,
  deliverCameraScan, pickBackCamera, type ScanPhase, type ScanStop,
} from '@/lib/cameraScan'
import { cameraFrameReader } from '@/lib/cameraReader'
import { isNativeApp, nativeScanOnce, ScannerNotReady } from '@/lib/nativeScan'
import { CameraDenied, startCameraScan, startHiddenScan } from '@/lib/nativeCamera'
import { toast } from '@/components/ui/Toast'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'

/** Можливості камери, яких ще немає в типах браузера: ліхтарик, наближення, режим фокуса. */
type CameraAbilities = MediaTrackCapabilities & { torch?: boolean; zoom?: { min: number; max: number }; focusMode?: string[] }

const SCAN_EVERY_MS = 40
const denied = (error: unknown) => error instanceof Error && /permission|notallowed|denied/i.test(error.name + error.message)

/**
 * Один звуковий пристрій на весь час роботи. На iPhone звук, створений не під час натискання, мовчить — тому пристрій
 * створюється й «будиться» в момент натискання «курка», а сигнал лише грає через нього.
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
  try { navigator.vibrate?.(60) } catch { /* optional */ }
  try {
    wakeAudio()
    if (!audio) return
    const tone = audio.createOscillator(), gain = audio.createGain()
    tone.frequency.value = 1320; gain.gain.value = 0.18
    tone.connect(gain); gain.connect(audio.destination)
    tone.start(); tone.stop(audio.currentTime + 0.12)
  } catch { /* звук необов'язковий */ }
}
/** Камера, вибрана минулого разу (і чи це «потрійна»/«подвійна»): просимо її одразу — один запит до телефона. */
function rememberedCamera(): { id: string; multi: boolean } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(LIVE_CAMERA_DEVICE_KEY) ?? 'null') as { id?: unknown; multi?: unknown } | null
    return saved && typeof saved.id === 'string' && saved.id ? { id: saved.id, multi: saved.multi === true } : null
  } catch { return null }
}
function rememberCamera(camera: { id: string; multi: boolean } | null) {
  try { if (camera) localStorage.setItem(LIVE_CAMERA_DEVICE_KEY, JSON.stringify(camera)); else localStorage.removeItem(LIVE_CAMERA_DEVICE_KEY) } catch { /* optional */ }
}
const publish = (phase: ScanPhase, reason?: ScanStop) => window.dispatchEvent(new CustomEvent(SCAN_TRIGGER_STATE_EVENT, { detail: { phase, reason } }))

/**
 * Одне сканування «курком»: камера + ліхтарик → перший зчитаний код → усе вимикається.
 * stop() можна кликати скільки завгодно разів; після нього камера гарантовано відпущена (доріжки зупинено).
 */
function runScanSession(video: HTMLVideoElement, onEnd: () => void): { stop: (why: ScanStop) => void } {
  let stopped = false
  let stream: MediaStream | null = null
  let loop: number | null = null, deadline: number | null = null
  const release = () => { stream?.getTracks().forEach(track => track.stop()); stream = null; try { video.srcObject = null } catch { /* optional */ } }
  const stop = (why: ScanStop) => {
    if (stopped) return
    stopped = true
    if (loop !== null) window.clearInterval(loop)
    if (deadline !== null) window.clearTimeout(deadline)
    release()
    onEnd()
    publish('idle', why)
    if (why === 'timeout') toast.warning('Штрихкод не зчитано. Піднесіть телефон ближче до коду й натисніть сканер ще раз.')
  }
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } }

  async function openCamera(): Promise<void> {
    let multi = false
    // Спершу — камера, вибрана минулого разу: один запит до телефона. Не вийшло (телефон змінив її код) — звичайний шлях.
    const remembered = rememberedCamera()
    if (remembered) {
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: remembered.id }, ...size }, audio: false }); multi = remembered.multi }
      catch (error) { if (denied(error)) throw error; rememberCamera(null); stream = null }
    }
    if (!stream) {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, ...size }, audio: false })
      if (stopped) { release(); return }
      // Назви камер видно лише після дозволу. «Потрійна»/«подвійна ширококутна» задня сама переходить на макро зблизька.
      try {
        const better = pickBackCamera(await navigator.mediaDevices.enumerateDevices())
        const current = stream.getVideoTracks()[0]?.getSettings().deviceId
        if (better && better !== current && !stopped) {
          const next = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: better }, ...size }, audio: false })
          stream.getTracks().forEach(track => track.stop())
          stream = next
        }
        multi = Boolean(better)
        const chosen = stream.getVideoTracks()[0]?.getSettings().deviceId
        rememberCamera(chosen ? { id: chosen, multi } : null)
      } catch { /* лишаємось на камері за замовчуванням */ }
    }
    if (stopped) { release(); return }
    video.srcObject = stream
    await video.play().catch(() => undefined)
    if (stopped) { release(); return }
    const track = stream.getVideoTracks()[0]
    try {
      const abilities = (track?.getCapabilities?.() ?? {}) as CameraAbilities
      const settings: Record<string, unknown> = {}
      // Ліхтарик — разом із камерою, як на ручному сканері: світить на код і показує, куди дивиться камера.
      if (abilities.torch) settings.torch = true
      if (abilities.focusMode?.includes('continuous')) settings.focusMode = 'continuous'
      // Одна ширококутна камера зблизька не фокусується: наближення ×2 — телефон тримають далі, код різкий.
      if (!multi && abilities.zoom && abilities.zoom.max >= 2) settings.zoom = Math.max(abilities.zoom.min, 2)
      if (Object.keys(settings).length) await track.applyConstraints({ advanced: [settings as MediaTrackConstraintSet] }).catch(() => undefined)
    } catch { /* без ліхтарика теж читає */ }
  }

  publish('starting')
  void (async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera')
      // Камера й розпізнавач готуються одночасно; камеру просимо в ту саму мить, що й натискання.
      const [read] = await Promise.all([cameraFrameReader(), openCamera()])
      if (stopped) return
      publish('scanning')
      deadline = window.setTimeout(() => stop('timeout'), SCAN_SESSION_MS)
      let busy = false
      loop = window.setInterval(() => {
        if (busy || stopped || video.readyState < 2) return
        busy = true
        void read(video).then(found => {
          const code = found.map(item => String(item.rawValue ?? '').trim()).find(value => value && value.length <= 200)
          if (!code || stopped) return
          beep()
          const outcome = deliverCameraScan(code)
          window.dispatchEvent(new CustomEvent(SCAN_TRIGGER_READ_EVENT, { detail: { code, outcome } }))
          stop('read')
        }, () => undefined).finally(() => { busy = false })
      }, SCAN_EVERY_MS)
    } catch (error) {
      if (stopped) return
      toast.error(denied(error) ? 'Доступ до камери заборонено. Дозвольте камеру для цього сайту в налаштуваннях браузера.'
        : 'Сканер не запустився: камера недоступна або немає звʼязку. Спробуйте ще раз.')
      stop('error')
    }
  })()
  return { stop }
}

/**
 * Сканер штрихкодів камерою для вебу — «курок», як на ручному сканері (26.11.2026, слово власника). На екрані від нього
 * нічого немає: відео невидиме (2×2 точки; display:none не годиться — телефон тоді зупиняє відео). Керує ним значок
 * сканера біля поля пошуку (LiveCameraButton): натиснув — камера й ліхтарик увімкнулись, код зчитано — усе вимкнулось.
 * Поза натисканням камера вимкнена й дозволу не тримає.
 */
/**
 * Застосунок на телефоні (27.11.2026): замість камери через браузер — рідний сканер телефона. Той самий «курок»,
 * той самий звук і той самий шлях коду; сканер відкривається на весь екран і закривається сам після зчитування.
 */
function runNativeScan(onEnd: () => void): { stop: (why: ScanStop) => void } {
  let ended = false
  let cancelCamera: (() => void) | null = null
  let deadline: number | null = null
  const end = (why: ScanStop) => {
    if (ended) return
    ended = true
    if (deadline !== null) window.clearTimeout(deadline)
    cancelCamera?.()
    if (why === 'timeout') toast.warning('Штрихкод не зчитано. Піднесіть телефон ближче до коду й натисніть сканер ще раз.')
    publish('idle', why); onEnd()
  }
  const read = (code: string | null) => {
    if (ended) return
    if (!code) { end('cancel'); return }
    beep()
    const outcome = deliverCameraScan(code)
    window.dispatchEvent(new CustomEvent(SCAN_TRIGGER_READ_EVENT, { detail: { code, outcome } }))
    end('read')
  }
  const failed = (error: unknown) => {
    if (error instanceof ScannerNotReady) toast.warning(error.message)
    else toast.error('Сканер телефона не запустився. Перевірте дозвіл на камеру в налаштуваннях застосунку й спробуйте ще раз.')
    end('error')
  }
  publish('starting')
  // 27.11.2026 (слово власника «камера не потрібна, треба прямо в рядку»): спершу — невидима камера з ліхтариком, екран
  // програми лишається, код іде в рядок. Не вийшло — камера на весь екран, далі — сканер Google на окремому екрані.
  let hidden = false
  void startHiddenScan().then(
    scan => { hidden = true; return scan },
    error => { if (error instanceof CameraDenied) throw error; return startCameraScan() },
  ).then(scan => {
    if (ended) { scan.cancel(); return }
    cancelCamera = scan.cancel
    publish('scanning')
    deadline = window.setTimeout(() => end('timeout'), SCAN_SESSION_MS * 2)
    void scan.done.then(read)
  }).catch(error => {
    if (ended) return
    if (error instanceof CameraDenied) { toast.error('Немає дозволу на камеру. Дозвольте камеру для «Форсаж» у налаштуваннях телефона.'); end('error'); return }
    publish('scanning')
    void nativeScanOnce().then(read).catch(failed)
  })
  // Невидимий режим — як у вебі: «відпустив курок», повторне натискання, код або час. На весь екран «відпустив» не доходить.
  return { stop: why => { if (hidden || why === 'cancel' || why === 'error') end(why) } }
}

export function LiveCameraScanner() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const session = useRef<{ stop: (why: ScanStop) => void } | null>(null)
  const signedIn = useAuthStore(store => Boolean(store.session))
  const off = isDesktopRuntime() || !signedIn

  useEffect(() => {
    if (off) return
    const start = () => {
      const video = videoRef.current
      if (session.current || !video) return
      if (isNativeApp()) { wakeAudio(); session.current = runNativeScan(() => { session.current = null }); return }
      wakeAudio()
      session.current = runScanSession(video, () => { session.current = null })
    }
    const stop = (event: Event) => session.current?.stop(((event as CustomEvent<{ reason?: ScanStop }>).detail?.reason) ?? 'cancel')
    // Телефон заблокували або перейшли в іншу програму — камеру відпускаємо.
    const hidden = () => { if (document.hidden) session.current?.stop('cancel') }
    window.addEventListener(SCAN_TRIGGER_START_EVENT, start)
    window.addEventListener(SCAN_TRIGGER_STOP_EVENT, stop)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener(SCAN_TRIGGER_START_EVENT, start); window.removeEventListener(SCAN_TRIGGER_STOP_EVENT, stop)
      document.removeEventListener('visibilitychange', hidden)
      session.current?.stop('cancel')
    }
  }, [off])

  if (off) return null
  return (
    <div aria-hidden="true" data-live-camera-hidden className="pointer-events-none fixed left-0 top-0 z-0 h-[2px] w-[2px] overflow-hidden opacity-[0.01] print:hidden">
      <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
    </div>
  )
}
