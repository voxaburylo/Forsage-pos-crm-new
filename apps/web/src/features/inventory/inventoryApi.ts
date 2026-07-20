import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { requestDesktopSync } from '@/features/products/productApi'
import { useAuthStore } from '@/stores/authStore'

const DEFAULT_READ_TIMEOUT_MS = 10_000
const DEFAULT_WRITE_TIMEOUT_MS = 15_000
const DEFAULT_COMPLETE_TIMEOUT_MS = 120_000

type RequestOptions = { silent?: boolean; timeoutMs?: number }

type ApiResponse<T> = { data: T }

function userId(): string | undefined {
  return useAuthStore.getState().session?.user?.id ?? undefined
}

function localInventory() {
  return desktopBridge()?.inventory ?? null
}

function withUser<T extends Record<string, unknown>>(input: T = {} as T): T & { user_id?: string } {
  return { ...input, user_id: userId() }
}

export const inventoryApi = {
  listSessions: async (opts: RequestOptions = {}): Promise<ApiResponse<any[]>> => {
    const local = localInventory()
    if (local?.listSessions) return { data: await local.listSessions({}) }
    return api.get<ApiResponse<any[]>>('/api/v1/inventory', {
      silent: opts.silent ?? true,
      timeoutMs: opts.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
    })
  },

  createSession: async (body: { name: string; created_by?: string | null; created_at?: string | null }, opts: RequestOptions = {}): Promise<ApiResponse<any>> => {
    const local = localInventory()
    if (local?.createSession) return { data: await local.createSession(body) }
    return api.post<ApiResponse<any>>('/api/v1/inventory', body, undefined, {
      silent: opts.silent ?? true,
      timeoutMs: opts.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS,
    })
  },

  startSession: async (id: string, opts: RequestOptions = {}): Promise<ApiResponse<any>> => {
    const local = localInventory()
    if (local?.startSession) return { data: await local.startSession(id, withUser({})) }
    return api.post<ApiResponse<any>>(`/api/v1/inventory/${id}/start`, {}, undefined, {
      silent: opts.silent ?? true,
      timeoutMs: opts.timeoutMs ?? DEFAULT_COMPLETE_TIMEOUT_MS,
    })
  },

  deleteSession: async (id: string, opts: RequestOptions = {}): Promise<void> => {
    const local = localInventory()
    if (local?.deleteSession) {
      await local.deleteSession(id)
      return
    }
    await api.delete<void>(`/api/v1/inventory/${id}`, {
      silent: opts.silent ?? true,
      timeoutMs: opts.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS,
    } as any)
  },

  getSession: async (id: string, opts: RequestOptions = {}): Promise<ApiResponse<any>> => {
    const local = localInventory()
    if (local?.getSession) return { data: await local.getSession(id, withUser({})) }
    return api.get<ApiResponse<any>>(`/api/v1/inventory/${id}`, {
      silent: opts.silent ?? true,
      timeoutMs: opts.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
    })
  },

  getLabels: async (id: string, opts: RequestOptions = {}): Promise<ApiResponse<any[]>> => {
    const local = localInventory()
    if (local?.labels) return { data: await local.labels(id) }
    return api.get<ApiResponse<any[]>>(`/api/v1/inventory/${id}/labels`, {
      silent: opts.silent ?? true,
      timeoutMs: opts.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
    })
  },

  findProduct: async (id: string, input: { code?: string; product_id?: string }, opts: RequestOptions = {}): Promise<ApiResponse<any>> => {
    const local = localInventory()
    if (local?.findProduct) return { data: await local.findProduct(id, input) }
    const code = input.code ?? input.product_id ?? ''
    return api.get<ApiResponse<any>>(`/api/v1/inventory/${id}/product?code=${encodeURIComponent(code)}`, {
      silent: opts.silent ?? true,
      timeoutMs: opts.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
    })
  },

  count: async (id: string, body: { product_id: string; qty: number; price_checked?: boolean; observed_retail_price?: number | null }, opts: RequestOptions = {}): Promise<{ data: any; session: any }> => {
    const local = localInventory()
    if (local?.count) return local.count(id, withUser(body))
    return api.post<{ data: any; session: any }>(`/api/v1/inventory/${id}/count`, body, undefined, {
      silent: opts.silent ?? true,
      timeoutMs: opts.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS,
    })
  },

  scan: async (id: string, body: { barcode?: string; product_id?: string; qty?: number }, opts: RequestOptions = {}): Promise<ApiResponse<{ item: any }>> => {
    const local = localInventory()
    if (local?.scan) return { data: await local.scan(id, withUser(body)) }
    return api.post<ApiResponse<{ item: any }>>(`/api/v1/inventory/${id}/scan`, body, undefined, {
      silent: opts.silent ?? true,
      timeoutMs: opts.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS,
    })
  },

  setItemQty: async (id: string, itemId: string, countedStock: number, opts: RequestOptions = {}): Promise<ApiResponse<any>> => {
    const local = localInventory()
    if (local?.setItemQty) return { data: await local.setItemQty(id, itemId, { counted_stock: countedStock }) }
    return api.put<ApiResponse<any>>(`/api/v1/inventory/${id}/items/${itemId}`, { counted_stock: countedStock }, {
      silent: opts.silent ?? true,
      timeoutMs: opts.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS,
    })
  },

  applyPrice: async (id: string, body: { product_id: string; retail_price: number }, opts: RequestOptions = {}): Promise<{ data: any; session: any }> => {
    const local = localInventory()
    if (local?.applyPrice) {
      const result = await local.applyPrice(id, body)
      requestDesktopSync()
      return result
    }
    return api.post<{ data: any; session: any }>(`/api/v1/inventory/${id}/apply-price`, body, undefined, {
      silent: opts.silent ?? true,
      timeoutMs: opts.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS,
    })
  },

  complete: async (id: string, opts: RequestOptions = {}): Promise<ApiResponse<{ items_updated?: number }>> => {
    const local = localInventory()
    if (local?.complete) {
      const data = await local.complete(id, withUser({}))
      requestDesktopSync()
      return { data }
    }
    return api.post<ApiResponse<{ items_updated?: number }>>(`/api/v1/inventory/${id}/complete`, {}, undefined, {
      silent: opts.silent ?? true,
      timeoutMs: opts.timeoutMs ?? DEFAULT_COMPLETE_TIMEOUT_MS,
    })
  },
}