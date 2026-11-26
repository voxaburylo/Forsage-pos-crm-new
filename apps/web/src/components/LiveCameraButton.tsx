import { useEffect, useRef, useState } from 'react'
import { Check, ScanBarcode } from 'lucide-react'
import {
  SCAN_TRIGGER_READ_EVENT, SCAN_TRIGGER_START_EVENT, SCAN_TRIGGER_STATE_EVENT, SCAN_TRIGGER_STOP_EVENT, triggerOnPress, triggerOnRelease,
  type ScanPhase, type ScanStop,
} from '@/lib/cameraScan'
import { warmCameraReader } from '@/lib/cameraReader'
import { isDesktopRuntime } from '@/lib/desktopBridge'

const READ_FLASH_MS = 900

/**
 * «Курок» сканера біля поля пошуку (каса, товари, ревізія) у вебі.
 * 26.11.2026, слово власника: «значок сканера, і як на сканері: натиснув — буквально за секунду камера зчитала
 * штрихкод, зі спалахом одночасно; щойно зчитано — автоматично вимикається. Максимально яскраво й зрозуміло».
 *  — сірий значок сканера — вимкнено;
 *  — жовтий, пульсує — камера й ліхтарик увімкнені, шукає код;
 *  — зелений з галочкою — зчитано, усе вимкнулось.
 * Натиснув і тримаєш — сканує, доки тримаєш; коротко натиснув — чекає на код кілька секунд; натиснув ще раз — скасував.
 * Дії не забирають курсор із поля (preventDefault на pointerdown): код потрапляє туди ж, куди й код USB-сканера.
 */
export function LiveCameraButton({ className = '', size = 20, label = 'Сканувати штрихкод' }: { className?: string; size?: number; label?: string }) {
  const [phase, setPhase] = useState<ScanPhase>('idle')
  const [read, setRead] = useState(false)
  const press = useRef<{ at: number; started: boolean } | null>(null)
  const phaseRef = useRef<ScanPhase>('idle')
  const desktop = isDesktopRuntime()

  // Розпізнавач готуємо заздалегідь: перше натискання не чекає на його завантаження.
  useEffect(() => { if (!desktop) warmCameraReader() }, [desktop])
  useEffect(() => {
    let flash: number | null = null
    const onState = (event: Event) => {
      const next = (event as CustomEvent<{ phase?: ScanPhase }>).detail?.phase ?? 'idle'
      phaseRef.current = next; setPhase(next)
    }
    const onRead = () => {
      setRead(true)
      if (flash !== null) window.clearTimeout(flash)
      flash = window.setTimeout(() => setRead(false), READ_FLASH_MS)
    }
    window.addEventListener(SCAN_TRIGGER_STATE_EVENT, onState)
    window.addEventListener(SCAN_TRIGGER_READ_EVENT, onRead)
    return () => {
      window.removeEventListener(SCAN_TRIGGER_STATE_EVENT, onState); window.removeEventListener(SCAN_TRIGGER_READ_EVENT, onRead)
      if (flash !== null) window.clearTimeout(flash)
      // Екран закрили посеред сканування — камеру відпускаємо.
      if (phaseRef.current !== 'idle') window.dispatchEvent(new CustomEvent(SCAN_TRIGGER_STOP_EVENT, { detail: { reason: 'cancel' satisfies ScanStop } }))
    }
  }, [])

  // У програмі на ПК — USB-сканер; камера там не вмикається.
  if (desktop) return null
  const stop = (reason: ScanStop) => window.dispatchEvent(new CustomEvent(SCAN_TRIGGER_STOP_EVENT, { detail: { reason } }))
  const down = () => {
    if (triggerOnPress(phaseRef.current) === 'cancel') { press.current = { at: Date.now(), started: false }; stop('cancel'); return }
    press.current = { at: Date.now(), started: true }
    window.dispatchEvent(new CustomEvent(SCAN_TRIGGER_START_EVENT))
  }
  const up = () => {
    const current = press.current
    press.current = null
    if (current && triggerOnRelease(current.started, Date.now() - current.at) === 'stop' && phaseRef.current !== 'idle') stop('release')
  }
  const busy = phase !== 'idle'
  const tone = read ? '!bg-emerald-500 !text-white !border-emerald-500' : busy ? '!bg-yellow-400 !text-black !border-yellow-400 animate-pulse' : ''
  return (
    <button type="button" data-scan-trigger={read ? 'read' : phase}
      onPointerDown={event => { event.preventDefault(); try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* optional */ } down() }}
      onPointerUp={event => { event.preventDefault(); up() }}
      onPointerCancel={up}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event => { if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) { event.preventDefault(); down(); press.current = null } }}
      aria-label={busy ? 'Скасувати сканування' : label} aria-pressed={busy} title={busy ? 'Сканує… натисніть, щоб скасувати' : label}
      style={{ touchAction: 'none', WebkitTouchCallout: 'none', userSelect: 'none', WebkitUserSelect: 'none' }}
      className={`${className} transition-colors duration-150 ${tone}`}>
      {read ? <Check size={size} strokeWidth={3} /> : <ScanBarcode size={size} />}
    </button>
  )
}
