import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { requestDesktopSync } from '@/features/products/productApi'
import { useAuthStore } from '@/stores/authStore'
import type {
  Supplier, PaginatedSuppliers,
  SupplyInvoice, PaginatedInvoices, SupplierDebtsResult,
} from '@/types/supplier'

export interface SupplierFilters {
  search?: string
  is_active?: 'true' | 'false'
  page?: number
  per_page?: number
}

export interface InvoiceFilters {
  status?: string
  supplier_id?: string
  page?: number
  per_page?: number
}

function currentUserId(): string | undefined {
  return useAuthStore.getState().session?.user?.id ?? undefined
}

function localSupply() {
  return desktopBridge()?.supply ?? null
}

function buildQuery(filters: object): string {
  const params = new URLSearchParams()
  Object.entries(filters as Record<string, unknown>).forEach(([k, v]) => {
    if (v !== undefined && v !== '') params.set(k, String(v))
  })
  return params.toString() ? `?${params.toString()}` : ''
}

export const supplierApi = {
  // Постачальники
  list: async (filters: SupplierFilters = {}) => {
    const local = localSupply()
    if (local?.listSuppliers) return local.listSuppliers(filters) as Promise<PaginatedSuppliers>
    return api.get<PaginatedSuppliers>(`/api/v1/suppliers${buildQuery(filters)}`)
  },

  get: async (id: string) => {
    const local = localSupply()
    if (local?.getSupplier) return { data: await local.getSupplier(id) } as { data: Supplier }
    return api.get<{ data: Supplier }>(`/api/v1/suppliers/${id}`)
  },

  create: (body: { name: string; phone?: string | null; email?: string | null; contact_name?: string | null; notes?: string | null }) =>
    api.post<{ data: Supplier }>('/api/v1/suppliers', body),

  update: (id: string, body: Partial<{ name: string; phone: string | null; email: string | null; contact_name: string | null; notes: string | null }>) =>
    api.put<{ data: Supplier }>(`/api/v1/suppliers/${id}`, body),

  delete: (id: string) =>
    api.delete<void>(`/api/v1/suppliers/${id}`),

  merge: (primaryId: string, duplicateId: string) =>
    api.post<{ data: Supplier }>('/api/v1/suppliers/merge', {
      primary_supplier_id: primaryId,
      duplicate_supplier_id: duplicateId,
    }),

  // Борги перед постачальниками
  getDebts: () =>
    api.get<{ data: SupplierDebtsResult }>('/api/v1/suppliers/debts'),

  // Приходні накладні
  listInvoices: async (filters: InvoiceFilters = {}) => {
    const local = localSupply()
    if (local?.listInvoices) return local.listInvoices(filters) as Promise<PaginatedInvoices>
    return api.get<PaginatedInvoices>(`/api/v1/suppliers/invoices${buildQuery(filters)}`)
  },

  getInvoice: async (id: string) => {
    const local = localSupply()
    if (local?.getInvoice) return { data: await local.getInvoice(id) } as { data: SupplyInvoice }
    return api.get<{ data: SupplyInvoice }>(`/api/v1/suppliers/invoices/${id}`)
  },

  createInvoice: async (body: { supplier_id?: string | null; invoice_number?: string | null; notes?: string | null; paid_amount?: number; payment_method?: 'cash' | 'card' | 'transfer' | null; fund_source?: 'cashbox' | 'owner_funds' | 'bank_account' | 'business_card' | null; shift_id?: string | null; items: Array<{ product_id: string; qty: number; purchase_price: number; total: number }> }) => {
    const local = localSupply()
    if (local?.createInvoice) {
      const data = await local.createInvoice({ ...body, user_id: currentUserId() })
      requestDesktopSync()
      return { data } as { data: SupplyInvoice }
    }
    return api.post<{ data: SupplyInvoice }>('/api/v1/suppliers/invoices', body)
  },

  updateInvoice: async (id: string, body: { invoice_number?: string | null; notes?: string | null }) => {
    const local = localSupply()
    if (local?.updateInvoice) {
      const data = await local.updateInvoice(id, { ...body, user_id: currentUserId() })
      requestDesktopSync()
      return { data } as { data: SupplyInvoice }
    }
    return api.put<{ data: SupplyInvoice }>(`/api/v1/suppliers/invoices/${id}`, body)
  },

  payInvoice: async (id: string, body: {
    amount: number
    payment_method: 'cash' | 'card' | 'transfer'
    fund_source: 'cashbox' | 'owner_funds' | 'bank_account' | 'business_card'
    shift_id?: string | null
    note?: string | null
  }) => {
    const local = localSupply()
    if (local?.payInvoice) {
      const data = await local.payInvoice(id, { ...body, user_id: currentUserId() })
      requestDesktopSync()
      return { data } as { data: SupplyInvoice }
    }
    return api.post<{ data: SupplyInvoice }>(`/api/v1/suppliers/invoices/${id}/pay`, body)
  },

  postInvoice: async (id: string) => {
    const local = localSupply()
    if (local?.postInvoice) {
      const data = await local.postInvoice(id, { user_id: currentUserId() })
      requestDesktopSync()
      return { data } as { data: SupplyInvoice }
    }
    return api.post<{ data: SupplyInvoice }>(`/api/v1/suppliers/invoices/${id}/post`, {})
  },

  cancelInvoice: async (id: string) => {
    const local = localSupply()
    if (local?.cancelInvoice) {
      const data = await local.cancelInvoice(id)
      requestDesktopSync()
      return { data } as { data: SupplyInvoice }
    }
    return api.post<{ data: SupplyInvoice }>(`/api/v1/suppliers/invoices/${id}/cancel`, {})
  },

  deleteInvoice: async (id: string) => {
    const local = localSupply()
    if (local?.deleteInvoice) {
      await local.deleteInvoice(id)
      requestDesktopSync()
      return
    }
    return api.delete<void>(`/api/v1/suppliers/invoices/${id}`)
  },
}