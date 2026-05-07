import { api } from '@/lib/api'
import type { Product, PaginatedProducts, ProductFormData } from '@/types/product'
import { hryvniaToKopecks } from '@/types/product'

export interface ProductFilters {
  search?: string
  category_id?: string
  brand_id?: string
  is_active?: string
  low_stock?: string
  page?: number
  per_page?: number
}

function buildQuery(filters: ProductFilters): string {
  const params = new URLSearchParams()
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== '') params.set(k, String(v))
  })
  return params.toString() ? `?${params.toString()}` : ''
}

function formToApi(form: ProductFormData) {
  return {
    sku: form.sku,
    name: form.name,
    barcode: form.barcode || null,
    brand_id: form.brand_id || null,
    category_id: form.category_id || null,
    unit: form.unit,
    purchase_price: hryvniaToKopecks(form.purchase_price),
    retail_price: hryvniaToKopecks(form.retail_price),
    qty_on_hand: parseFloat(form.qty_on_hand || '0'),
    reorder_point: parseFloat(form.reorder_point || '0'),
    notes: form.notes || null,
    is_active: form.is_active,
  }
}

export const productApi = {
  list: (filters: ProductFilters = {}) =>
    api.get<PaginatedProducts>(`/api/v1/products${buildQuery(filters)}`),

  get: (id: string) =>
    api.get<{ data: Product }>(`/api/v1/products/${id}`),

  search: (q: string, limit = 10) =>
    api.get<{ data: Product[] }>(`/api/v1/products/search?q=${encodeURIComponent(q)}&limit=${limit}`),

  create: (form: ProductFormData) =>
    api.post<{ data: Product }>('/api/v1/products', formToApi(form)),

  update: (id: string, form: Partial<ProductFormData>) =>
    api.put<{ data: Product }>(`/api/v1/products/${id}`, formToApi(form as ProductFormData)),

  delete: (id: string) =>
    api.delete<void>(`/api/v1/products/${id}`),

  priceHistory: (id: string) =>
    api.get<{ data: unknown[] }>(`/api/v1/products/${id}/price-history`),
}
