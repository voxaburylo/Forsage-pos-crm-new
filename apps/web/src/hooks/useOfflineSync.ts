import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import { toast } from '@/components/ui/Toast'
import {
  cacheProducts, getProductsCacheAge,
  getPendingSales, removePendingSale, countPendingSales,
} from '@/lib/offlineDB'

const CACHE_TTL_MS = 30 * 60 * 1000   // 30 хвилин

export function useOfflineSync(serverOnline: boolean) {
  const [pendingCount, setPendingCount]   = useState(0)
  const [syncing, setSyncing]             = useState(false)
  const [lastCached, setLastCached]       = useState<Date | null>(null)
  const syncTriggeredRef = useRef(false)

  // Оновлюємо лічильник pending при монтуванні
  useEffect(() => {
    countPendingSales().then(setPendingCount).catch(() => {})
  }, [])

  // Кеш товарів — оновлюємо якщо онлайн і кеш застарів
  const refreshProductCache = useCallback(async () => {
    if (!serverOnline) return
    const age = await getProductsCacheAge()
    const stale = !age || (Date.now() - age) > CACHE_TTL_MS

    if (!stale) {
      setLastCached(age ? new Date(age) : null)
      return
    }

    try {
      const res = await api.get<{ data: any[] }>('/api/v1/products?per_page=2000&is_active=true', { silent: true })
      await cacheProducts(res.data ?? [])
      setLastCached(new Date())
    } catch {
      // Не критично — кеш просто не оновився
    }
  }, [serverOnline])

  useEffect(() => {
    refreshProductCache()
  }, [refreshProductCache])

  // Синхронізація pending продажів при відновленні зв'язку
  const syncPendingSales = useCallback(async () => {
    if (!serverOnline || syncing || syncTriggeredRef.current) return

    const pending = await getPendingSales()
    if (pending.length === 0) return

    syncTriggeredRef.current = true
    setSyncing(true)

    let successCount = 0
    let failCount    = 0

    for (const sale of pending) {
      try {
        await api.post('/api/v1/sales', {
          shift_id:       sale.shift_id,
          customer_id:    sale.customer_id,
          manager_id:     sale.manager_id,
          items:          sale.items,
          payment_method: sale.payment_method,
          notes:          sale.notes,
        }, { 'X-Idempotency-Key': sale.idempotency_key } as any)

        await removePendingSale(sale.offline_id)
        successCount++
      } catch {
        failCount++
      }
    }

    const newCount = await countPendingSales()
    setPendingCount(newCount)
    setSyncing(false)
    syncTriggeredRef.current = false

    if (successCount > 0) {
      toast.success(`Синхронізовано ${successCount} офлайн-продажів`)
    }
    if (failCount > 0) {
      toast.error(`${failCount} продажів не вдалось синхронізувати — перевірте журнал`)
    }
  }, [serverOnline, syncing])

  // При відновленні зв'язку — оновлюємо кеш і синхронізуємо
  useEffect(() => {
    if (serverOnline) {
      refreshProductCache()
      syncPendingSales()
    } else {
      syncTriggeredRef.current = false
    }
  }, [serverOnline])

  return {
    pendingCount,
    syncing,
    lastCached,
    refreshProductCache,
    syncPendingSales,
    incrementPending: () => setPendingCount((n) => n + 1),
  }
}
