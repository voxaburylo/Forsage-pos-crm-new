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
 * `stuck` — операції, які вичерпали швидкі спроби. Каса повертається до них
 * сама раз на кілька годин, тому це не «загублено назавжди», а «висить довше
 * ніж мало б». Саме через невидимість такої черги продаж міг залишитися лише
 * в локальній базі, а власник бачив у звітах меншу виручку.
 *
 * `enabled: false` повністю глушить опитування — на екрані касира лічильник
 * не потрібен, і зайвих звернень до бази робити нема за чим.
 */
export function useDesktopSyncHealth(enabled = true): DesktopSyncHealth {
  const [status, setStatus] = useState<DesktopSyncStatus | null>(null)

  const refresh = useCallback(async () => {
    if (!enabled || !isDesktopRuntime()) return
    setStatus(await getDesktopSyncStatus())
  }, [enabled])

  useEffect(() => {
    if (!enabled || !isDesktopRuntime()) return
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
  }, [enabled, refresh])

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
