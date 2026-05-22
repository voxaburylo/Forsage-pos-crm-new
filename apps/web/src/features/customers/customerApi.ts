import { api } from '@/lib/api'
import type { Customer, CustomerSale, PaginatedCustomers } from '@/types/customer'

export interface CustomerFilters {
  search?: string
  has_debt?: 'true' | 'false'
  tag?: string
  group_id?: string
  page?: number
  per_page?: number
}

function buildQuery(filters: CustomerFilters): string {
  const params = new URLSearchParams()
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== '') params.set(k, String(v))
  })
  return params.toString() ? `?${params.toString()}` : ''
}

export const customerApi = {
  list: (filters: CustomerFilters = {}) =>
    api.get<PaginatedCustomers>(`/api/v1/customers${buildQuery(filters)}`),

  get: (id: string) =>
    api.get<{ data: Customer }>(`/api/v1/customers/${id}`),

  getSales: (id: string) =>
    api.get<{ data: CustomerSale[] }>(`/api/v1/customers/${id}/sales`),

  create: (body: { phone: string; full_name?: string; email?: string; notes?: string; tags?: string[]; price_tier_id?: string | null }) =>
    api.post<{ data: Customer }>('/api/v1/customers', body),

  quickCreate: (phone: string, full_name: string) =>
    api.post<{ data: Customer }>('/api/v1/customers/quick', { phone, full_name }),

  update: (id: string, body: Partial<{ phone: string; full_name: string; email: string; notes: string; tags: string[]; price_tier_id: string | null; vip_level: string; risk_profile: string }>) =>
    api.put<{ data: Customer }>(`/api/v1/customers/${id}`, body),

  delete: (id: string) =>
    api.delete<void>(`/api/v1/customers/${id}`),

  payDebt: (id: string, amount: number, note?: string) =>
    api.post<{ data: Customer }>(`/api/v1/customers/${id}/pay-debt`, { amount, note }),
}
