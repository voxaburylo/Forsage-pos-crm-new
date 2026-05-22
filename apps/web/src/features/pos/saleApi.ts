import { api } from '@/lib/api'
import type { Sale, PriceCalculation } from '@/types/sale'

interface CreateSaleBody {
  shift_id: string
  customer_id?: string | null
  manager_id?: string | null
  items: Array<{ product_id: string; qty: number; unit_price: number; discount: number }>
  payment_method: 'cash' | 'card' | 'debt' | 'mixed' | 'transfer'
  discount?: number
  notes?: string
  cash_amount?: number
  card_amount?: number
  is_fiscal?: boolean
}

export const saleApi = {
  create: (body: CreateSaleBody, idempotencyKey?: string) => {
    const headers = idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : undefined
    return api.post<{ data: Sale }>('/api/v1/sales', body, headers)
  },

  get: (id: string) =>
    api.get<{ data: Sale }>(`/api/v1/sales/${id}`),

  list: (params: Record<string, string | number | undefined> = {}) => {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined) q.set(k, String(v)) })
    return api.get<{ data: Sale[]; pagination: unknown }>(`/api/v1/sales?${q}`)
  },

  calculatePrice: (items: Array<{ product_id: string; qty: number }>) =>
    api.post<{ data: PriceCalculation[] }>('/api/v1/sales/calculate-price', { items }),

  suspend: (body: {
    shift_id: string; customer_id?: string | null; manager_id?: string | null
    items: Array<{ product_id: string; qty: number; unit_price: number; discount: number }>
    payment_method: 'cash' | 'card' | 'debt' | 'mixed' | 'transfer'
    notes?: string; pickup_cell?: string | null; expires_at?: string
  }) => api.post<{ data: Sale }>('/api/v1/sales/suspend', body),

  listSuspended: () =>
    api.get<{ data: Sale[] }>('/api/v1/sales/suspended'),

  checkAfterPayment: (shiftId: string, after: string) =>
    api.get<{ data: Sale | null }>(`/api/v1/sales/check-after-payment?shift_id=${shiftId}&after=${encodeURIComponent(after)}`),

  resume: (id: string) =>
    api.post<{ data: Sale }>(`/api/v1/sales/${id}/resume`, {}),
}
