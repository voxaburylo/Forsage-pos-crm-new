import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { requestDesktopSync } from '@/features/products/productApi'
import { useAuthStore } from '@/stores/authStore'

const READ_TIMEOUT_MS = 10_000
const WRITE_TIMEOUT_MS = 30_000

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

  addPayment: async (orderId: string, body: any, opts: Options = {}) => {
    const local = localOrders()
    if (local?.addPayment) {
      const result = await local.addPayment(orderId, { ...body, user_id: userId() })
      requestDesktopSync()
      return result
    }
    return api.post(`/api/v1/customer-orders/${orderId}/payments`, body, undefined, { silent: opts.silent ?? true, timeoutMs: opts.timeoutMs ?? WRITE_TIMEOUT_MS })
  },

  complete: async (orderId: string, body: any, opts: Options = {}) => {
    const local = localOrders()
    if (local?.complete) {
      const result = await local.complete(orderId, { ...body, user_id: userId() })
      requestDesktopSync()
      return result
    }
    return api.post(`/api/v1/customer-orders/${orderId}/complete`, body, undefined, { silent: opts.silent ?? true, timeoutMs: opts.timeoutMs ?? WRITE_TIMEOUT_MS })
  },
}