import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import { toast } from '@/components/ui/Toast'
import {
  applySyncChanges,
  cacheStaff,
  completePendingSaleSync,
  countPendingSales,
  ensurePersistentStorage,
  getLocalSyncState,
  getPendingSales,
  markPendingSaleFailed,
  markSyncAttempt,
  markSyncError,
  type SyncChanges,
} from '@/lib/offlineDB'
import { useAuthStore } from '@/stores/authStore'

export const LOCAL_SYNC_IDLE_INTERVAL_MS = 30 * 1000
export const LOCAL_SYNC_PENDING_INTERVAL_MS = 5 * 1000
export const LOCAL_SYNC_RETRY_MIN_MS = 15 * 1000
export const LOCAL_SYNC_RETRY_MAX_MS = 5 * 60 * 1000
export const REFERENCE_REFRESH_INTERVAL_MS = 15 * 60 * 1000
let globalSyncInProgress = false

export function useOfflineSync(serverOnline: boolean) {
  const scopeKey = useAuthStore((state) => state.session?.user?.id ?? '')
  const [pendingCount, setPendingCount] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [lastCached, setLastCached] = useState<Date | null>(null)
  const [lastSyncError, setLastSyncError] = useState<string | null>(null)
  const retryAttemptRef = useRef(0)

  useEffect(() => {
    countPendingSales().then(setPendingCount).catch(() => {})
    ensurePersistentStorage().catch(() => {})
    if (scopeKey) {
      getLocalSyncState(scopeKey).then((state) => {
        setLastCached(state.last_success_at ? new Date(state.last_success_at) : null)
        setLastSyncError(state.last_error)
      }).catch(() => {})
    }
  }, [scopeKey])

  const pushPendingSales = useCallback(async () => {
    const pending = await getPendingSales()
    let successCount = 0
    let failCount = 0

    for (const sale of pending) {
      try {
        const response = await api.post<{ data: any }>('/api/v1/sales', {
          shift_id: sale.shift_id,
          customer_id: sale.customer_id,
          customer_order_id: sale.customer_order_id,
          manager_id: sale.manager_id,
          items: sale.items,
          payment_method: sale.payment_method,
          notes: sale.notes ?? undefined,
          is_fiscal: sale.is_fiscal,
          terminal_auth_code: sale.terminal_auth_code,
          discount: sale.discount,
          bonuses_spent: sale.bonuses_spent,
          cash_amount: sale.cash_amount,
          card_amount: sale.card_amount,
        }, {
          'X-Idempotency-Key': sale.idempotency_key,
        }, {
          silent: true,
          timeoutMs: 30_000,
        })

        await completePendingSaleSync(sale.offline_id, response.data)
        successCount++
      } catch (error) {
        await markPendingSaleFailed(
          sale.offline_id,
          error instanceof Error ? error.message : 'Невідома помилка синхронізації',
        )
        failCount++
      }
    }

    setPendingCount(await countPendingSales())
    return { successCount, failCount }
  }, [])

  const pullChanges = useCallback(async (forceSnapshot = false) => {
    if (!scopeKey) return
    const localState = await getLocalSyncState(scopeKey)
    const since = forceSnapshot ? null : localState.cursor
    const includeReferences = !since
      || !localState.last_reference_sync_at
      || Date.now() - localState.last_reference_sync_at >= REFERENCE_REFRESH_INTERVAL_MS
    if (!since) {
      // Службові позиції мають потрапити вже в перший локальний знімок.
      await Promise.allSettled([
        api.post('/api/v1/sales/quick-item', { kind: 'tire_service' }),
        api.post('/api/v1/sales/quick-item', { kind: 'free_sale' }),
      ])
    }
    const params = new URLSearchParams()
    if (since) params.set('since', since)
    if (includeReferences) params.set('include_references', 'true')
    const query = params.size > 0 ? `?${params.toString()}` : ''
    const [response, staff] = await Promise.all([
      api.get<{ data: SyncChanges }>(`/api/v1/sync/changes${query}`, {
        silent: true,
        timeoutMs: 120_000,
      }),
      api.get<{ data: any[] }>('/api/v1/admin/staff-options', {
        silent: true,
        timeoutMs: 30_000,
      }).catch(() => null),
    ])
    await applySyncChanges(response.data, scopeKey, !since)
    if (staff) await cacheStaff(staff.data ?? [], scopeKey)
    const syncedAt = new Date()
    setLastCached(syncedAt)
    setLastSyncError(null)
  }, [scopeKey])

  const syncNow = useCallback(async (
    options: { forceSnapshot?: boolean; notify?: boolean } = {},
  ) => {
    if (!serverOnline || !scopeKey || globalSyncInProgress) return

    globalSyncInProgress = true
    setSyncing(true)
    await markSyncAttempt(scopeKey).catch(() => {})

    try {
      const pushed = await pushPendingSales()
      await pullChanges(options.forceSnapshot)
      retryAttemptRef.current = 0
      if (options.notify) {
        toast.success(pushed.successCount > 0
          ? `Синхронізовано чеків: ${pushed.successCount}`
          : 'Локальні дані синхронізовано')
      }
      if (pushed.failCount > 0) {
        const message = `Не вдалося синхронізувати чеків: ${pushed.failCount}`
        setLastSyncError(message)
        if (options.notify) toast.warning(message)
      }
    } catch (error) {
      retryAttemptRef.current += 1
      const message = error instanceof Error ? error.message : 'Помилка синхронізації'
      setLastSyncError(message)
      await markSyncError(scopeKey, message).catch(() => {})
      if (options.notify) toast.error(message)
    } finally {
      globalSyncInProgress = false
      setSyncing(false)
      setPendingCount(await countPendingSales().catch(() => 0))
    }
  }, [serverOnline, scopeKey, pushPendingSales, pullChanges])

  useEffect(() => {
    if (!serverOnline || !scopeKey) return

    let cancelled = false
    let timer: number | null = null

    const scheduleNext = async (immediate = false) => {
      if (cancelled) return
      if (timer !== null) window.clearTimeout(timer)

      const queued = await countPendingSales().catch(() => 0)
      const retryDelay = Math.min(
        LOCAL_SYNC_RETRY_MAX_MS,
        LOCAL_SYNC_RETRY_MIN_MS * (2 ** Math.max(0, retryAttemptRef.current - 1)),
      )
      const delay = immediate
        ? 0
        : retryAttemptRef.current > 0
          ? retryDelay
          : queued > 0
            ? LOCAL_SYNC_PENDING_INTERVAL_MS
            : LOCAL_SYNC_IDLE_INTERVAL_MS

      timer = window.setTimeout(async () => {
        await syncNow()
        await scheduleNext()
      }, delay)
    }

    const requestImmediateSync = () => { void scheduleNext(true) }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') requestImmediateSync()
    }

    window.addEventListener('forsage:sync-requested', requestImmediateSync)
    window.addEventListener('online', requestImmediateSync)
    document.addEventListener('visibilitychange', handleVisibility)
    void scheduleNext(true)

    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      window.removeEventListener('forsage:sync-requested', requestImmediateSync)
      window.removeEventListener('online', requestImmediateSync)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [serverOnline, scopeKey, syncNow])

  const refreshProductCache = useCallback(
    async (force = false) => syncNow({ forceSnapshot: force, notify: false }),
    [syncNow],
  )

  return {
    pendingCount,
    syncing,
    lastCached,
    lastSyncError,
    refreshProductCache,
    syncPendingSales: () => syncNow({ notify: true }),
    incrementPending: () => {
      setPendingCount((count) => count + 1)
      window.dispatchEvent(new Event('forsage:sync-requested'))
    },
  }
}
