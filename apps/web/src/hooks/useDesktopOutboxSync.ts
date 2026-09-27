import { isDesktopAccessLocked } from '@/lib/desktopAccessState'
import { useCallback, useEffect, useRef, useState } from 'react'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { syncDesktopNow } from '@/lib/desktopSyncApi'
import { useAuthStore } from '@/stores/authStore'

const IDLE_INTERVAL_MS = 60_000
const PENDING_INTERVAL_MS = 10_000
const RETRY_MIN_MS = 15_000
const RETRY_MAX_MS = 5 * 60_000
const STARTUP_DELAY_MS = 1_500
const IMMEDIATE_SYNC_DELAY_MS = 2_000

export function desktopSyncDelay(pending: boolean, retryAttempt: number, hidden: boolean): number {
  if (retryAttempt > 0) return Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(10, retryAttempt - 1))
  if (pending) return PENDING_INTERVAL_MS
  return hidden ? 120_000 : IDLE_INTERVAL_MS
}

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
    if (isDesktopAccessLocked() || !serverOnline || !userId || offlineMode || !isDesktopRuntime()) return { pushed: 0, failed: 0, pending: 0 }
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
    let running = false
    let requested = false

    const schedule = (delay: number) => {
      if (cancelled) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(async () => {
        timer = null
        if (running) { requested = true; return }
        running = true
        const result = await syncNow()
        running = false
        const nextDelay = requested && retryAttemptRef.current === 0 ? IMMEDIATE_SYNC_DELAY_MS
          : desktopSyncDelay(result.pushed > 0 || result.pending > 0, retryAttemptRef.current, document.visibilityState !== 'visible')
        requested = false
        schedule(nextDelay)
      }, delay)
    }

    const requestImmediateSync = () => { if (running) requested = true; else schedule(IMMEDIATE_SYNC_DELAY_MS) }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        requestImmediateSync()
      }
    }

    window.addEventListener('forsage:desktop-access-changed', requestImmediateSync)
    window.addEventListener('forsage:desktop-sync-requested', requestImmediateSync)
    window.addEventListener('online', requestImmediateSync)
    document.addEventListener('visibilitychange', handleVisibility)
    schedule(STARTUP_DELAY_MS)

    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      window.removeEventListener('forsage:desktop-access-changed', requestImmediateSync)
      window.removeEventListener('forsage:desktop-sync-requested', requestImmediateSync)
      window.removeEventListener('online', requestImmediateSync)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [serverOnline, userId, offlineMode, syncNow])

  return { syncing, lastError, syncNow }
}
