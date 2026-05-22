import { api } from '@/lib/api'
import type { Product, PaginatedProducts, ProductFormData } from '@/types/product'
import { hryvniaToKopecks } from '@/types/product'

export interface StockBreakdown {
  on_hand: number
  reserved: number
  available: number
}

export interface ProductFilters {
  search?: string
  category_id?: string
  brand_id?: string
  is_active?: string
  low_stock?: string
  page?: number
  per_page?: number
  sort_field?: 'sku' | 'name' | 'retail_price' | 'qty_on_hand' | 'created_at'
  sort_dir?: 'asc' | 'desc'
}

function buildQuery(filters: ProductFilters): string {
  const params = new URLSearchParams()
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== '') params.set(k, String(v))
  })
  return params.toString() ? `?${params.toString()}` : ''
}

function formToApi(form: ProductFormData) {
  // Прибираємо порожні spec-поля щоб не захаращувати JSONB
  const specs: Record<string, string> = {}
  for (const [k, v] of Object.entries(form.specs ?? {})) {
    if (v !== '' && v !== null && v !== undefined) specs[k] = String(v)
  }
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
    storage_bin: form.storage_bin || null,
    is_favorite: form.is_favorite,
    specs: Object.keys(specs).length > 0 ? specs : null,
    photo_url: form.photo_url || null,
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

  getStock: (id: string) =>
    api.get<{ data: StockBreakdown }>(`/api/v1/products/${id}/stock`),

  priceHistory: (id: string) =>
    api.get<{ data: unknown[] }>(`/api/v1/products/${id}/price-history`),

  generateBarcode: (id: string) =>
    api.post<{ data: Product }>(`/api/v1/products/${id}/generate-barcode`, {}),

  merge: (primaryId: string, duplicateId: string) =>
    api.post<{ data: Product }>('/api/v1/products/merge', {
      primary_product_id: primaryId,
      duplicate_product_id: duplicateId,
    }),

  getAnalogs: (id: string) =>
    api.get<{ analogs: any[]; grouped: Record<string, any[]> }>(`/api/v1/products/${id}/analogs`),

  getFitment: (id: string) =>
    api.get<{ fitments: any[]; grouped: Record<string, any[]> }>(`/api/v1/products/${id}/fitment`),

  getHistory: (id: string) =>
    api.get<{ data: any[] }>(`/api/v1/products/${id}/history`),

  getCobuy: (id: string) =>
    api.get<any[]>(`/api/v1/products/${id}/cobuy`),
}
