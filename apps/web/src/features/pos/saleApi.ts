import { api, type RequestOptions } from '@/lib/api'
import type { Sale, PriceCalculation } from '@/types/sale'

interface CreateSaleBody {
  shift_id: string
  customer_id?: string | null
  customer_order_id?: string | null
  manager_id?: string | null
  items: Array<{ product_id: string; qty: number; unit_price: number; discount: number }>
  payment_method: 'cash' | 'card' | 'debt' | 'mixed' | 'transfer'
  discount?: number
  notes?: string
  cash_amount?: number
  card_amount?: number
  is_fiscal?: boolean
  terminal_auth_code?: string | null
}

type SaleRequestOptions = Pick<RequestOptions, 'silent' | 'timeoutMs'>

const SALE_READ_TIMEOUT_MS = 10_000
const SALE_WRITE_TIMEOUT_MS = 20_000

export const saleApi = {
  create: (body: CreateSaleBody, idempotencyKey?: string) => {
    const headers = idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : undefined
    // Таймаут, щоб вікно оплати не зависало назавжди. Достатньо для інтегрованого
    // терміналу (агент чекає до ~2 хв) + запас. Повтор безпечний завдяки idempotency key.
    const timeoutMs = body.payment_method === 'card' || body.payment_method === 'mixed'
      ? 150_000
      : 20_000
    return api.post<{ data: Sale }>('/api/v1/sales', body, headers, { timeoutMs, silent: true })
  },

  get: (id: string, opts: SaleRequestOptions = {}) =>
    api.get<{ data: Sale }>(`/api/v1/sales/${id}`, { timeoutMs: SALE_READ_TIMEOUT_MS, ...opts }),

  list: (
    params: Record<string, string | number | undefined> = {},
    opts: Pick<RequestOptions, 'silent' | 'timeoutMs'> = {},
  ) => {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined) q.set(k, String(v)) })
    return api.get<{ data: Sale[]; pagination: unknown }>(`/api/v1/sales?${q}`, opts)
  },

  calculatePrice: (items: Array<{ product_id: string; qty: number }>, opts: SaleRequestOptions = {}) =>
    api.post<{ data: PriceCalculation[] }>('/api/v1/sales/calculate-price', { items }, undefined, { timeoutMs: SALE_READ_TIMEOUT_MS, ...opts }),

  suspend: (body: {
    confirmed_by_cashier: true
    shift_id: string; customer_id?: string | null; manager_id?: string | null
    items: Array<{ product_id: string; qty: number; unit_price: number; discount: number }>
    payment_method: 'cash' | 'card' | 'debt' | 'mixed' | 'transfer'
    notes?: string; pickup_cell?: string | null; expires_at?: string
  }, opts: SaleRequestOptions = {}) =>
    api.post<{ data: Sale }>('/api/v1/sales/suspend', body, undefined, { timeoutMs: SALE_WRITE_TIMEOUT_MS, ...opts }),

  listSuspended: (opts: SaleRequestOptions = {}) =>
    api.get<{ data: Sale[] }>('/api/v1/sales/suspended', { timeoutMs: SALE_READ_TIMEOUT_MS, ...opts }),

  checkAfterPayment: (shiftId: string, after: string, opts: SaleRequestOptions = {}) =>
    api.get<{ data: Sale | null }>(`/api/v1/sales/check-after-payment?shift_id=${shiftId}&after=${encodeURIComponent(after)}`, { timeoutMs: SALE_READ_TIMEOUT_MS, ...opts }),

  resume: (id: string, opts: SaleRequestOptions = {}) =>
    api.post<{ data: Sale }>(`/api/v1/sales/${id}/resume`, {}, undefined, { timeoutMs: SALE_WRITE_TIMEOUT_MS, ...opts }),

  confirmResume: (id: string, opts: SaleRequestOptions = {}) =>
    api.post<{ data: Pick<Sale, 'id' | 'sale_number' | 'total' | 'status'> }>(`/api/v1/sales/${id}/resume/confirm`, {}, undefined, { timeoutMs: SALE_WRITE_TIMEOUT_MS, ...opts }),

  discardSuspended: (id: string, opts: SaleRequestOptions = {}) =>
    api.delete<{ data: Pick<Sale, 'id' | 'sale_number' | 'total' | 'status'> }>(`/api/v1/sales/${id}/suspended`, { timeoutMs: SALE_WRITE_TIMEOUT_MS, ...opts }),
}
