import { useCallback, useEffect, useRef, useState } from 'react'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { syncDesktopNow } from '@/lib/desktopSyncApi'
import { useAuthStore } from '@/stores/authStore'

const IDLE_INTERVAL_MS = 10_000
const PENDING_INTERVAL_MS = 10_000
const RETRY_MIN_MS = 15_000
const RETRY_MAX_MS = 5 * 60_000
const STARTUP_DELAY_MS = 1_500
const IMMEDIATE_SYNC_DELAY_MS = 2_000

export function hasMeaningfulDesktopSyncChanges(result: {
  pushed: number
  pulled: { counts: Record<string, number> } | null
}): boolean {
  // У фоновому режимі сервер нічого не повертає до каси: локальна база —
  // єдине робоче джерело. Показувати оновлення слід лише після резервного
  // запису її власних операцій.
  void result.pulled
  return result.pushed > 0
}

export function useDesktopOutboxSync(serverOnline: boolean) {
  const userId = useAuthStore((state) => state.session?.user?.id ?? '')
  const offlineMode = useAuthStore((state) => state.offlineMode)
  const [syncing, setSyncing] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  const retryAttemptRef = useRef(0)
  const syncNow = useCallback(async () => {
    if (!serverOnline || !userId || offlineMode || !isDesktopRuntime()) return { pushed: 0, failed: 0, pending: 0 }
    setSyncing(true)
    try {
      const result = await syncDesktopNow()
      retryAttemptRef.current = result.failed > 0 ? retryAttemptRef.current + 1 : 0
      setLastError(result.failed > 0 ? `Не синхронізовано desktop-операцій: ${result.failed}` : null)
      if (hasMeaningfulDesktopSyncChanges(result)) {
        window.dispatchEvent(new CustomEvent('forsage:desktop-sync-completed', { detail: result }))
      }
      return result
    } catch (error) {
      retryAttemptRef.current += 1
      setLastError(error instanceof Error ? error.message : 'Помилка desktop-синхронізації')
      return { pushed: 0, failed: 1, pending: 0 }
    } finally {
      setSyncing(false)
    }
  }, [serverOnline, userId, offlineMode])

  useEffect(() => {
    if (!serverOnline || !userId || offlineMode || !isDesktopRuntime()) return

    let cancelled = false
    let timer: number | null = null

    const schedule = (delay: number) => {
      if (cancelled) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(async () => {
        const result = await syncNow()
        const retryDelay = Math.min(
          RETRY_MAX_MS,
          RETRY_MIN_MS * (2 ** Math.max(0, retryAttemptRef.current - 1)),
        )
        const nextDelay = retryAttemptRef.current > 0
          ? retryDelay
          : result.pushed > 0 || result.pending > 0
            ? PENDING_INTERVAL_MS
            : IDLE_INTERVAL_MS
        schedule(nextDelay)
      }, delay)
    }

    const requestImmediateSync = () => schedule(IMMEDIATE_SYNC_DELAY_MS)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        requestImmediateSync()
      } else {
        schedule(1_000)
      }
    }

    window.addEventListener('forsage:desktop-sync-requested', requestImmediateSync)
    window.addEventListener('online', requestImmediateSync)
    document.addEventListener('visibilitychange', handleVisibility)
    schedule(STARTUP_DELAY_MS)

    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      window.removeEventListener('forsage:desktop-sync-requested', requestImmediateSync)
      window.removeEventListener('online', requestImmediateSync)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [serverOnline, userId, offlineMode, syncNow])

  return { syncing, lastError, syncNow }
}
