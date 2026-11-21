import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { freshnessAdvanced, WEB_DATA_UPDATED_EVENT } from '@/hooks/useWebDataRevision'

/** Скільки хвилин тому дані з каси востаннє дійшли до сервера; null — невідомо. */
export function freshnessAgeMinutes(lastAt: string | null, now = Date.now()): number | null {
  if (!lastAt) return null
  const time = Date.parse(lastAt)
  return Number.isFinite(time) ? Math.max(0, Math.floor((now - time) / 60_000)) : null
}

export function freshnessLabel(lastAt: string | null, now = Date.now()): string {
  const age = freshnessAgeMinutes(lastAt, now)
  if (age === null) return 'Дані з каси ще не надходили'
  const when = new Date(Date.parse(lastAt!)).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  return `Дані станом на ${when}`
}

// 21.11.2026: частіше (було 120 с) і лише поки вкладка видима — щоб відкрита сторінка оновлювалась сама.
const REFRESH_MS = 20_000
// Каса шле зміни кожні кілька хвилин; довша тиша — привід перевірити, чи вона увімкнена й онлайн.
export const STALE_AFTER_MINUTES = 30

/**
 * Лише у веб-версії: основна база живе на касі, тому власник бачить, наскільки свіжа копія.
 * У програмі на касі дані завжди поточні — значок не показується.
 */
export function DataFreshness() {
  const [lastAt, setLastAt] = useState<string | null | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  const web = !isDesktopRuntime()

  useEffect(() => {
    if (!web) return
    let cancelled = false
    let previous: string | null | undefined
    const load = () => {
      if (document.visibilityState !== 'visible') return
      void api.get<{ data: { last_local_data_at: string | null } }>('/api/v1/sync/freshness', { silent: true, timeoutMs: 15_000 })
        .then(({ data }) => {
          if (cancelled) return
          // Каса надіслала нові дані — відкриті списки перечитуються самі.
          if (freshnessAdvanced(previous, data.last_local_data_at)) window.dispatchEvent(new Event(WEB_DATA_UPDATED_EVENT))
          previous = data.last_local_data_at
          setLastAt(data.last_local_data_at); setNow(Date.now())
        })
        .catch(() => { /* Без відповіді просто не показуємо значок. */ })
    }
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    document.addEventListener('visibilitychange', load)
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', load) }
  }, [web])

  if (!web || lastAt === undefined) return null
  const age = freshnessAgeMinutes(lastAt, now)
  const stale = age === null || age > STALE_AFTER_MINUTES
  return (
    <span
      data-testid="data-freshness"
      title="Основна база — у програмі на касі. Тут показано копію, яку каса надіслала на сервер."
      className={`hidden sm:inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${stale ? 'bg-amber-50 text-amber-700' : 'bg-gray-50 text-gray-500'}`}
    >
      <RefreshCw size={11} />
      {freshnessLabel(lastAt, now)}
    </span>
  )
}
