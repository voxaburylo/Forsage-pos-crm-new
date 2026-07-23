import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'
import type { Customer, CustomerSale, PaginatedCustomers } from '@/types/customer'

export interface CustomerFilters {
  search?: string
  has_debt?: 'true' | 'false'
  tag?: string
  group_id?: string
  sort?: 'name' | 'recent' | 'debt'
  page?: number
  per_page?: number
}

export interface CustomerCreateResponse {
  data: Customer
  meta?: { reused: boolean; vehicle_added: boolean }
}

function buildQuery(filters: CustomerFilters): string {
  const params = new URLSearchParams()
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== '') params.set(k, String(v))
  })
  return params.toString() ? `?${params.toString()}` : ''
}

export const customerApi = {
  list: async (filters: CustomerFilters = {}) => {
    // Групи клієнтів поки зберігаються на сервері; з реальною онлайн-сесією
    // desktop використовує той самий відфільтрований список, що й браузер.
    if (filters.group_id && desktopBridge() && !useAuthStore.getState().offlineMode) {
      return api.get<PaginatedCustomers>(`/api/v1/customers${buildQuery(filters)}`)
    }
    const local = desktopBridge()?.pos.listCustomers
    if (local) return local(filters) as Promise<PaginatedCustomers>
    return api.get<PaginatedCustomers>(`/api/v1/customers${buildQuery(filters)}`)
  },

  get: async (id: string) => {
    const local = desktopBridge()?.pos.getCustomer
    if (local) return { data: await local(id) as Customer }
    return api.get<{ data: Customer }>(`/api/v1/customers/${id}`)
  },

  getSales: async (id: string) => {
    const local = desktopBridge()?.pos.getCustomerSales
    if (local) return { data: await local(id) as CustomerSale[] }
    return api.get<{ data: CustomerSale[] }>(`/api/v1/customers/${id}/sales`)
  },

  create: async (body: { phone: string; full_name?: string; email?: string; birth_date?: string | null; notes?: string; tags?: string[]; price_tier_id?: string | null; discount_pct?: number; client_status?: string; card_barcode?: string | null; vehicle?: { brand?: string; model?: string; year?: number | null; vin?: string | null; notes?: string | null } }) => {
    const local = desktopBridge()?.pos.saveCustomer
    if (local) {
      const result = await local(body)
      window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
      return result as CustomerCreateResponse
    }
    return api.post<CustomerCreateResponse>('/api/v1/customers', body)
  },

  quickCreate: async (phone: string, full_name: string) => {
    const local = desktopBridge()?.pos.saveCustomer
    if (local) {
      const result = await local({ phone, full_name })
      window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
      return result as CustomerCreateResponse
    }
    return api.post<CustomerCreateResponse>('/api/v1/customers/quick', { phone, full_name })
  },

  update: async (id: string, body: Partial<{ phone: string; full_name: string; email: string; notes: string; tags: string[]; price_tier_id: string | null; vip_level: string; risk_profile: string; birth_date: string | null; discount_pct: number; bonus_balance: number; loyalty_mode: 'discount' | 'cashback'; client_status: string; card_barcode: string | null }>) => {
    const local = desktopBridge()?.pos.saveCustomer
    if (local) {
      const result = await local(body, id)
      window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
      return { data: result.data as Customer }
    }
    return api.put<{ data: Customer }>(`/api/v1/customers/${id}`, body)
  },

  delete: async (id: string) => {
    const local = desktopBridge()?.pos.deleteCustomer
    if (local) {
      await local(id)
      window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
      return undefined as void
    }
    return api.delete<void>(`/api/v1/customers/${id}`)
  },

  payDebt: async (id: string, amount: number, note?: string) => {
    const local = desktopBridge()?.pos.payDebt
    if (local) {
      const result = await local({ customer_id: id, amount, method: 'cash', notes: note ?? null })
      window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
      return result as { data: Customer }
    }
    return api.post<{ data: Customer }>(`/api/v1/customers/${id}/pay-debt`, { amount, note })
  },
}
