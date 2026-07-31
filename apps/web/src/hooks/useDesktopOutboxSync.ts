import { useCallback, useEffect, useRef, useState } from 'react'
import { isDesktopRuntime, type DesktopSyncPullChanges } from '@/lib/desktopBridge'
import { syncDesktopNow } from '@/lib/desktopSyncApi'
import { useAuthStore } from '@/stores/authStore'

const IDLE_INTERVAL_MS = 10_000
const PENDING_INTERVAL_MS = 10_000
const RETRY_MIN_MS = 15_000
const RETRY_MAX_MS = 5 * 60_000
const STARTUP_DELAY_MS = 1_500
const FOREGROUND_QUIET_MS = 1_800
const IMMEDIATE_SYNC_DELAY_MS = 2_000
const MAX_FOREGROUND_PULL_ROWS = 250

const PERIODIC_SNAPSHOT_COUNTS = new Set([
  'staff',
  'categories',
  'brands',
  'commission_rules',
  'settings',
])

export function hasMeaningfulDesktopSyncChanges(result: {
  pushed: number
  pulled: { counts: Record<string, number> } | null
}): boolean {
  if (result.pushed > 0) return true
  return Object.entries(result.pulled?.counts ?? {}).some(
    ([key, count]) => !PERIODIC_SNAPSHOT_COUNTS.has(key) && Number(count) > 0,
  )
}

export function desktopPullRowCount(changes: DesktopSyncPullChanges): number {
  return Object.values(changes).reduce(
    (count, value) => count + (Array.isArray(value) ? value.length : 0),
    0,
  )
}

export function useDesktopOutboxSync(serverOnline: boolean) {
  const userId = useAuthStore((state) => state.session?.user?.id ?? '')
  const offlineMode = useAuthStore((state) => state.offlineMode)
  const [syncing, setSyncing] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  const retryAttemptRef = useRef(0)
  const lastUserActivityAtRef = useRef(0)

  const canApplyPull = useCallback((changes?: DesktopSyncPullChanges) => {
    if (document.visibilityState !== 'visible') return true
    if (Date.now() - lastUserActivityAtRef.current < FOREGROUND_QUIET_MS) return false
    // Невелика дельта швидко оновлює касу. Великий пакет не застосовуємо у
    // видимому вікні: курсор не зміниться, і пакет безпечно дочекається, доки
    // користувач згорне програму.
    return !changes || desktopPullRowCount(changes) <= MAX_FOREGROUND_PULL_ROWS
  }, [])

  const syncNow = useCallback(async (includeReferences = false) => {
    if (!serverOnline || !userId || offlineMode || !isDesktopRuntime()) return { pushed: 0, failed: 0, pending: 0 }
    if (!canApplyPull()) return { pushed: 0, failed: 0, pending: 0 }

    setSyncing(true)
    try {
      const result = await syncDesktopNow({ includeReferences, canApplyPull })
      retryAttemptRef.current = result.failed > 0 ? retryAttemptRef.current + 1 : 0
      setLastError(result.failed > 0 ? `Не синхронізовано desktop-операцій: ${result.failed}` : null)
      if (hasMeaningfulDesktopSyncChanges(result)) {
        window.dispatchEvent(new CustomEvent('forsage:desktop-sync-completed', { detail: result }))
      }
      if (Number(result.pulled?.counts?.settings ?? 0) > 0) {
        window.dispatchEvent(new CustomEvent('forsage:label-settings-synced', { detail: result }))
      }
      return result
    } catch (error) {
      retryAttemptRef.current += 1
      setLastError(error instanceof Error ? error.message : 'Помилка desktop-синхронізації')
      return { pushed: 0, failed: 1, pending: 0 }
    } finally {
      setSyncing(false)
    }
  }, [serverOnline, userId, offlineMode, canApplyPull])

  useEffect(() => {
    if (!isDesktopRuntime()) return
    const markActivity = () => { lastUserActivityAtRef.current = Date.now() }
    markActivity()
    window.addEventListener('keydown', markActivity, true)
    window.addEventListener('pointerdown', markActivity, true)
    window.addEventListener('input', markActivity, true)
    window.addEventListener('forsage:pos-scanner-stage', markActivity)
    return () => {
      window.removeEventListener('keydown', markActivity, true)
      window.removeEventListener('pointerdown', markActivity, true)
      window.removeEventListener('input', markActivity, true)
      window.removeEventListener('forsage:pos-scanner-stage', markActivity)
    }
  }, [])

  useEffect(() => {
    if (!serverOnline || !userId || offlineMode || !isDesktopRuntime()) return

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

    const requestImmediateSync = () => schedule(IMMEDIATE_SYNC_DELAY_MS)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        lastUserActivityAtRef.current = Date.now()
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
  }, [serverOnline, userId, offlineMode, syncNow])

  return { syncing, lastError, syncNow }
}
