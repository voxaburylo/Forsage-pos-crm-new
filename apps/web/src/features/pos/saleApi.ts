import { api } from '@/lib/api'
import type { Sale, PriceCalculation } from '@/types/sale'

interface CreateSaleBody {
  shift_id: string
  customer_id?: string | null
  items: Array<{ product_id: string; qty: number; unit_price: number; discount: number }>
  payment_method: 'cash' | 'card' | 'debt'
  discount?: number
  notes?: string
}

export const saleApi = {
  create: (body: CreateSaleBody) =>
    api.post<{ data: Sale }>('/api/v1/sales', body),

  get: (id: string) =>
    api.get<{ data: Sale }>(`/api/v1/sales/${id}`),

  list: (params: Record<string, string | number | undefined> = {}) => {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined) q.set(k, String(v)) })
    return api.get<{ data: Sale[]; pagination: unknown }>(`/api/v1/sales?${q}`)
  },

  calculatePrice: (items: Array<{ product_id: string; qty: number }>) =>
    api.post<{ data: PriceCalculation[] }>('/api/v1/sales/calculate-price', { items }),
}
