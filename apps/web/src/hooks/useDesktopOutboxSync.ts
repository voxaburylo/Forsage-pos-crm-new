import { useCallback, useEffect, useRef, useState } from 'react'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { syncDesktopNow } from '@/lib/desktopSyncApi'
import { useAuthStore } from '@/stores/authStore'

const IDLE_INTERVAL_MS = 10_000
const PENDING_INTERVAL_MS = 10_000
const RETRY_MIN_MS = 15_000
const RETRY_MAX_MS = 5 * 60_000
const STARTUP_DELAY_MS = 1_500

export function useDesktopOutboxSync(serverOnline: boolean) {
  const userId = useAuthStore((state) => state.session?.user?.id ?? '')
  const [syncing, setSyncing] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  const retryAttemptRef = useRef(0)

  const syncNow = useCallback(async (includeReferences = false) => {
    if (!serverOnline || !userId || !isDesktopRuntime()) return { pushed: 0, failed: 0, pending: 0 }

    setSyncing(true)
    try {
      const result = await syncDesktopNow({ includeReferences })
      retryAttemptRef.current = result.failed > 0 ? retryAttemptRef.current + 1 : 0
      setLastError(result.failed > 0 ? `Не синхронізовано desktop-операцій: ${result.failed}` : null)
      window.dispatchEvent(new CustomEvent('forsage:desktop-sync-completed', { detail: result }))
      return result
    } catch (error) {
      retryAttemptRef.current += 1
      setLastError(error instanceof Error ? error.message : 'Помилка desktop-синхронізації')
      return { pushed: 0, failed: 1, pending: 0 }
    } finally {
      setSyncing(false)
    }
  }, [serverOnline, userId])

  useEffect(() => {
    if (!serverOnline || !userId || !isDesktopRuntime()) return

    let cancelled = false
    let timer: number | null = null

    const schedule = (delay: number, includeReferences = false) => {
      if (cancelled) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(async () => {
        const result = await syncNow(includeReferences)
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

    const requestImmediateSync = () => schedule(0)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        requestImmediateSync()
      } else {
        // Повні довідники (штрихкоди, категорії тощо) важкі для SQLite.
        // Оновлюємо їх лише коли користувач згорнув програму.
        schedule(1_000, true)
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
  }, [serverOnline, userId, syncNow])

  return { syncing, lastError, syncNow }
}
