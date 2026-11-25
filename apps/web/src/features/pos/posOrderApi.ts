import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { durableLocalRequest } from '@/lib/durableLocalRequest'
import { requestDesktopSync } from '@/features/products/productApi'
import { useAuthStore } from '@/stores/authStore'
import { moneyOnlyAtTill } from '@/lib/moneyOnlyAtTill'

const READ_TIMEOUT_MS = 10_000

type Options = { silent?: boolean; timeoutMs?: number }

function userId(): string | undefined {
  return useAuthStore.getState().session?.user?.id ?? undefined
}

function localOrders() {
  return desktopBridge()?.orders ?? null
}

export const posOrderApi = {
  listReady: async (input: { search?: string; customer_id?: string | null; activeStatuses?: string; limit?: number } = {}, opts: Options = {}) => {
    const local = localOrders()
    if (local?.listReady) {
      return { data: await local.listReady({ search: input.search, customer_id: input.customer_id ?? undefined, limit: input.limit ?? 80 }) }
    }
    const params = new URLSearchParams()
    if (input.search?.trim()) params.set('search', input.search.trim())
    else params.set('status', input.activeStatuses ?? '')
    if (input.customer_id) params.set('customer_id', input.customer_id)
    params.set('per_page', String(input.limit ?? (input.search?.trim() ? 50 : 80)))
    const url = `/api/v1/customer-orders?${params.toString()}`
    return api.get<{ data: any[] }>(url, { silent: opts.silent ?? true, timeoutMs: opts.timeoutMs ?? READ_TIMEOUT_MS })
  },

  payments: async (orderId: string, opts: Options = {}) => {
    const local = localOrders()
    if (local?.listPayments) return { data: await local.listPayments(orderId) }
    return api.get<{ data: any[] }>(`/api/v1/customer-orders/${orderId}/payments`, { silent: opts.silent ?? true, timeoutMs: opts.timeoutMs ?? READ_TIMEOUT_MS })
  },

  addPayment: async (orderId: string, body: any, _opts: Options = {}) => {
    const local = localOrders()
    if (local?.addPayment) {
      const { payment_id: _transientId, ...details } = body
      const payload = { ...details, user_id: userId() }
      const result = await durableLocalRequest(`order-payment:${orderId}:${userId()}`, payload,
        payment_id => local.addPayment!(orderId, { ...payload, payment_id }))
      void _transientId
      requestDesktopSync()
      return result
    }
    return moneyOnlyAtTill()
  },

  /**
   * 25.11.2026 (рішення власника): видача замовлення без прийому грошей — внесене зараховується,
   * неоплачене одразу стає боргом клієнта. Лише на касі та ПК менеджера.
   */
  canHandOver: () => Boolean(localOrders()?.handOver),

  /** itemIds — часткова видача: вибрані прибулі позиції; решта переходить у нове замовлення. */
  handOver: async (orderId: string, itemIds?: string[]) => {
    const local = localOrders()
    if (local?.handOver) {
      const result = await local.handOver(orderId, itemIds)
      requestDesktopSync()
      return result
    }
    return moneyOnlyAtTill()
  },

  complete: async (orderId: string, body: any, _opts: Options = {}) => {
    const local = localOrders()
    if (local?.complete) {
      const result = await local.complete(orderId, { ...body, user_id: userId() })
      requestDesktopSync()
      return result
    }
    return moneyOnlyAtTill()
  },
}
