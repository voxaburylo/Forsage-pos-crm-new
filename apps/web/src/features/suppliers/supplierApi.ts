import { api } from '@/lib/api'
import type {
  Supplier, PaginatedSuppliers,
  SupplyInvoice, PaginatedInvoices,
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

function buildQuery(filters: object): string {
  const params = new URLSearchParams()
  Object.entries(filters as Record<string, unknown>).forEach(([k, v]) => {
    if (v !== undefined && v !== '') params.set(k, String(v))
  })
  return params.toString() ? `?${params.toString()}` : ''
}

export const supplierApi = {
  // Постачальники
  list: (filters: SupplierFilters = {}) =>
    api.get<PaginatedSuppliers>(`/api/v1/suppliers${buildQuery(filters)}`),

  get: (id: string) =>
    api.get<{ data: Supplier }>(`/api/v1/suppliers/${id}`),

  create: (body: { name: string; phone?: string | null; email?: string | null; contact_name?: string | null; notes?: string | null }) =>
    api.post<{ data: Supplier }>('/api/v1/suppliers', body),

  update: (id: string, body: Partial<{ name: string; phone: string | null; email: string | null; contact_name: string | null; notes: string | null }>) =>
    api.put<{ data: Supplier }>(`/api/v1/suppliers/${id}`, body),

  delete: (id: string) =>
    api.delete<void>(`/api/v1/suppliers/${id}`),

  // Приходні накладні
  listInvoices: (filters: InvoiceFilters = {}) =>
    api.get<PaginatedInvoices>(`/api/v1/suppliers/invoices${buildQuery(filters)}`),

  getInvoice: (id: string) =>
    api.get<{ data: SupplyInvoice }>(`/api/v1/suppliers/invoices/${id}`),

  createInvoice: (body: { supplier_id?: string | null; invoice_number?: string | null; notes?: string | null; items: Array<{ product_id: string; qty: number; purchase_price: number; total: number }> }) =>
    api.post<{ data: SupplyInvoice }>('/api/v1/suppliers/invoices', body),

  updateInvoice: (id: string, body: { invoice_number?: string | null; notes?: string | null }) =>
    api.put<{ data: SupplyInvoice }>(`/api/v1/suppliers/invoices/${id}`, body),

  postInvoice: (id: string) =>
    api.post<{ data: SupplyInvoice }>(`/api/v1/suppliers/invoices/${id}/post`, {}),

  cancelInvoice: (id: string) =>
    api.post<{ data: SupplyInvoice }>(`/api/v1/suppliers/invoices/${id}/cancel`, {}),

  deleteInvoice: (id: string) =>
    api.delete<void>(`/api/v1/suppliers/invoices/${id}`),
}