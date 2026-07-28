import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, RefreshCw, X } from 'lucide-react'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import type { DesktopSyncStatus } from '@/lib/desktopBridge'
import { getDesktopSyncStatus } from '@/lib/desktopSyncApi'

const POLL_INTERVAL_MS = 12_000
// Скільки секунд «у черзі» вважати нормою: свіжі операції їдуть за 10-15с,
// тому показуємо панель лише якщо щось справді залежало.
const STALE_AFTER_MS = 45_000

function ageMs(iso: string | null): number {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : 0
}

function formatAge(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'щойно'
  if (min < 60) return `${min} хв тому`
  const h = Math.floor(min / 60)
  return `${h} год тому`
}

/**
 * Видимий індикатор стану синхронізації для desktop-каси.
 * Тиша, коли все синхронізовано. Бурштиновий — коли щось залежало в черзі.
 * Червоний — коли операції вичерпали спроби (stuck) і потребують уваги.
 */
export function SyncStatusIndicator() {
  const [status, setStatus] = useState<DesktopSyncStatus | null>(null)
  const [expanded, setExpanded] = useState(false)
  const timerRef = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    const next = await getDesktopSyncStatus()
    setStatus(next)
  }, [])

  useEffect(() => {
    if (!isDesktopRuntime()) return
    let cancelled = false

    const tick = async () => {
      if (cancelled) return
      await refresh()
      if (cancelled) return
      timerRef.current = window.setTimeout(tick, POLL_INTERVAL_MS)
    }
    void tick()

    const onSynced = () => { void refresh() }
    window.addEventListener('forsage:desktop-sync-completed', onSynced)

    return () => {
      cancelled = true
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      window.removeEventListener('forsage:desktop-sync-completed', onSynced)
    }
  }, [refresh])

  const requestSyncNow = useCallback(() => {
    window.dispatchEvent(new CustomEvent('forsage:desktop-sync-requested'))
    // Дамо циклу мить попрацювати, потім оновимо картину.
    window.setTimeout(() => { void refresh() }, 1_500)
  }, [refresh])

  if (!status) return null

  const stuck = status.stuck
  const inFlight = status.pending + status.retrying
  const oldestAge = ageMs(status.oldest_created_at)
  const hasPullError = Boolean(status.pull_last_error)

  // Що показувати:
  //  - stuck>0 → червона тривога (завжди);
  //  - є залежані в черзі або помилка pull → бурштинова;
  //  - інакше тиша.
  const alarm = stuck > 0
  const warn = !alarm && ((inFlight > 0 && oldestAge >= STALE_AFTER_MS) || hasPullError)
  if (!alarm && !warn) return null

  const tone = alarm
    ? { ring: 'border-red-300', bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500' }
    : { ring: 'border-amber-300', bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-400' }

  const label = alarm
    ? `${stuck} не синхронізовано`
    : `Синхронізую ${inFlight}…`

  return (
    <div className="fixed bottom-4 right-4 z-[60] select-none">
      {expanded && (
        <div className={`mb-2 w-72 rounded-xl border ${tone.ring} ${tone.bg} p-3 shadow-lg`}>
          <div className="flex items-start justify-between gap-2">
            <p className={`text-sm font-semibold ${tone.text}`}>
              {alarm ? 'Є несинхронізовані операції' : 'Синхронізація триває'}
            </p>
            <button type="button" onClick={() => setExpanded(false)}
              className="shrink-0 text-gray-400 hover:text-gray-600" aria-label="Згорнути">
              <X size={15} />
            </button>
          </div>
          <ul className="mt-2 space-y-1 text-xs text-gray-600">
            {status.pending > 0 && <li>У черзі: <b>{status.pending}</b></li>}
            {status.retrying > 0 && <li>Повторюються: <b>{status.retrying}</b></li>}
            {stuck > 0 && <li className="text-red-600">Застрягли (потрібна увага): <b>{stuck}</b></li>}
            {status.oldest_created_at && (
              <li className="text-gray-400">Найстаріша: {formatAge(oldestAge)}</li>
            )}
            {status.last_error && (
              <li className="mt-1 rounded bg-white/70 px-2 py-1 font-mono text-[11px] text-gray-500 break-words">
                {status.last_error}
              </li>
            )}
          </ul>
          <button type="button" onClick={requestSyncNow}
            className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50">
            <RefreshCw size={13} /> Синхронізувати зараз
          </button>
          {alarm && (
            <p className="mt-2 text-[11px] leading-snug text-red-500">
              Якщо після кількох спроб не зникає — покажіть це повідомлення підтримці.
            </p>
          )}
        </div>
      )}
      <button type="button" onClick={() => setExpanded((v) => !v)}
        className={`flex items-center gap-2 rounded-full border ${tone.ring} ${tone.bg} px-3 py-1.5 text-xs font-semibold ${tone.text} shadow-md`}>
        {alarm
          ? <AlertTriangle size={14} />
          : <RefreshCw size={14} className="animate-spin" />}
        <span className={`inline-block h-2 w-2 rounded-full ${tone.dot}`} />
        {label}
      </button>
    </div>
  )
}
