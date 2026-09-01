import { useCallback, useEffect, useState } from 'react'
import { getDesktopSyncStatus } from '@/lib/desktopSyncApi'
import { isDesktopRuntime, type DesktopSyncStatus } from '@/lib/desktopBridge'

const POLL_INTERVAL_MS = 10_000

export type DesktopSyncSeverity = 'clean' | 'pending' | 'stuck'

export interface DesktopSyncHealth {
  status: DesktopSyncStatus | null
  severity: DesktopSyncSeverity
  refresh: () => Promise<void>
}

/**
 * Скільки локальних операцій ще не доїхало на сервер.
 *
 * `stuck` — це операції, які вичерпали 30 спроб і самі вже НЕ поїдуть ніколи.
 * Саме через їх невидимість продаж міг залишитися лише в локальній базі, а
 * власник бачив у звітах меншу виручку і не знав, що щось загубилось.
 */
export function useDesktopSyncHealth(): DesktopSyncHealth {
  const [status, setStatus] = useState<DesktopSyncStatus | null>(null)

  const refresh = useCallback(async () => {
    if (!isDesktopRuntime()) return
    setStatus(await getDesktopSyncStatus())
  }, [])

  useEffect(() => {
    if (!isDesktopRuntime()) return
    let cancelled = false
    let timer: number | null = null

    const tick = async () => {
      const next = await getDesktopSyncStatus()
      if (cancelled) return
      setStatus(next)
      timer = window.setTimeout(tick, POLL_INTERVAL_MS)
    }

    // Синхронізатор шле цю подію, коли щось реально поїхало — оновлюємо
    // лічильник одразу, щоб індикатор не «відставав» на десять секунд.
    const handleSyncCompleted = () => { void refresh() }
    window.addEventListener('forsage:desktop-sync-completed', handleSyncCompleted)
    void tick()

    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      window.removeEventListener('forsage:desktop-sync-completed', handleSyncCompleted)
    }
  }, [refresh])

  return { status, severity: syncSeverity(status), refresh }
}

export function syncSeverity(status: DesktopSyncStatus | null): DesktopSyncSeverity {
  if (!status) return 'clean'
  if (status.stuck > 0) return 'stuck'
  if (status.pending > 0 || status.retrying > 0) return 'pending'
  return 'clean'
}

/** Підпис для індикатора. Касиру потрібні слова, а не назви полів. */
export function syncHealthLabel(status: DesktopSyncStatus): string {
  if (status.stuck > 0) return `${status.stuck} не відправлено`
  const waiting = status.pending + status.retrying
  return `${waiting} чекає відправки`
}
