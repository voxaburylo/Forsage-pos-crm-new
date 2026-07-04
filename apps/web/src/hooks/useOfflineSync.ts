import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import { toast } from '@/components/ui/Toast'
import {
  cacheProducts, cacheCategories, cacheStaff, cacheCustomers, getProductsCacheAge, getProductsCacheScope,
  getPendingSales, removePendingSale, countPendingSales, markPendingSaleFailed,
  ensurePersistentStorage,
} from '@/lib/offlineDB'
import { useAuthStore } from '@/stores/authStore'

const CACHE_TTL_MS = 30 * 60 * 1000   // 30 хвилин

export function useOfflineSync(serverOnline: boolean) {
  const scopeKey = useAuthStore((state) => state.session?.user?.id ?? '')
  const [pendingCount, setPendingCount]   = useState(0)
  const [syncing, setSyncing]             = useState(false)
  const [lastCached, setLastCached]       = useState<Date | null>(null)
  const syncTriggeredRef = useRef(false)

  // Оновлюємо лічильник pending при монтуванні
  useEffect(() => {
    countPendingSales().then(setPendingCount).catch(() => {})
    ensurePersistentStorage().catch(() => {})
  }, [])

  // Кеш товарів — оновлюємо якщо онлайн і кеш застарів
  const refreshProductCache = useCallback(async (force = false) => {
    if (!serverOnline || !scopeKey) return
    const age = await getProductsCacheAge()
    const cachedScope = await getProductsCacheScope()
    const stale = force || !age || cachedScope !== scopeKey || (Date.now() - age) > CACHE_TTL_MS

    if (!stale) {
      setLastCached(age ? new Date(age) : null)
      return
    }

    try {
      // Ці дві службові позиції потрібні для офлайн-кнопок «Шиномонтаж»
      // та «Вільна сума». Гарантуємо їх існування до знімка каталогу.
      await Promise.all([
        api.post('/api/v1/sales/quick-item', { kind: 'tire_service' }),
        api.post('/api/v1/sales/quick-item', { kind: 'free_sale' }),
      ])
      const products: any[] = []
      let page = 1
      let totalPages = 1
      do {
        const res = await api.get<{
          data: any[]
          pagination?: { total_pages?: number }
        }>(`/api/v1/products?per_page=2000&page=${page}&is_active=true`, { silent: true })
        products.push(...(res.data ?? []))
        totalPages = Math.max(1, res.pagination?.total_pages ?? 1)
        page++
      } while (page <= totalPages)

      const customers: any[] = []
      let customerPage = 1
      let customerPages = 1
      do {
        const response = await api.get<{
          data: any[]
          pagination?: { total_pages?: number }
        }>(`/api/v1/customers?per_page=100&page=${customerPage}`, { silent: true })
        customers.push(...(response.data ?? []))
        customerPages = Math.max(1, response.pagination?.total_pages ?? 1)
        customerPage++
      } while (customerPage <= customerPages)

      const categories = await api.get<{ data: any[] }>('/api/v1/admin/categories', { silent: true })
      const staff = await api.get<{ data: any[] }>('/api/v1/admin/staff-options', { silent: true })
      await cacheProducts(products, scopeKey)
      await cacheCategories(categories.data ?? [], scopeKey)
      await cacheStaff(staff.data ?? [], scopeKey)
      await cacheCustomers(customers, scopeKey)
      setLastCached(new Date())
    } catch {
      // Не критично — кеш просто не оновився
    }
  }, [serverOnline, scopeKey])

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
          customer_order_id: sale.customer_order_id,
          manager_id:     sale.manager_id,
          items:          sale.items,
          payment_method: sale.payment_method,
          notes:          sale.notes ?? undefined,
          is_fiscal:      sale.is_fiscal,
          terminal_auth_code: sale.terminal_auth_code,
          discount:       sale.discount,
          bonuses_spent:  sale.bonuses_spent,
          cash_amount:    sale.cash_amount,
          card_amount:    sale.card_amount,
        }, { 'X-Idempotency-Key': sale.idempotency_key } as any)

        await removePendingSale(sale.offline_id)
        successCount++
      } catch (error) {
        await markPendingSaleFailed(
          sale.offline_id,
          error instanceof Error ? error.message : 'Невідома помилка синхронізації',
        )
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
    if (successCount > 0) {
      await refreshProductCache(true)
    }
  }, [serverOnline, syncing, refreshProductCache])

  // При відновленні зв'язку — оновлюємо кеш і синхронізуємо
  useEffect(() => {
    if (serverOnline) {
      void (async () => {
        await syncPendingSales()
        await refreshProductCache()
      })()
    } else {
      syncTriggeredRef.current = false
    }
  }, [serverOnline])

  // Якщо сервер доступний, але окремий запит синхронізації тимчасово впав,
  // повторюємо чергу без перезавантаження сторінки.
  useEffect(() => {
    if (!serverOnline || pendingCount === 0) return
    const timer = window.setInterval(syncPendingSales, 60_000)
    return () => window.clearInterval(timer)
  }, [serverOnline, pendingCount, syncPendingSales])

  return {
    pendingCount,
    syncing,
    lastCached,
    refreshProductCache,
    syncPendingSales,
    incrementPending: () => setPendingCount((n) => n + 1),
  }
}
