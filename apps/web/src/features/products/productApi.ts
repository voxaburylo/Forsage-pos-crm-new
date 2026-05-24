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

function cleanSpecs(raw: Record<string, string> | undefined | null): Record<string, string> | null {
  if (!raw) return null
  const specs: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v !== '' && v !== null && v !== undefined) specs[k] = String(v)
  }
  return Object.keys(specs).length > 0 ? specs : null
}

// Create — требует ВСЕ поля формы, маппит с дефолтами.
function formToCreatePayload(form: ProductFormData) {
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
    specs: cleanSpecs(form.specs),
    photo_url: form.photo_url || null,
  }
}

// Update — маппит ТОЛЬКО переданные ключи. Поля, отсутствующие в partial,
// в payload не попадают и на бэке остаются неизменными.
// Не использовать formToCreatePayload для partial — он заполнит отсутствующие
// поля дефолтами (0/null) и обнулит товар.
function formToUpdatePayload(partial: Partial<ProductFormData>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (partial.sku !== undefined)            out.sku = partial.sku
  if (partial.name !== undefined)           out.name = partial.name
  if (partial.barcode !== undefined)        out.barcode = partial.barcode || null
  if (partial.brand_id !== undefined)       out.brand_id = partial.brand_id || null
  if (partial.category_id !== undefined)    out.category_id = partial.category_id || null
  if (partial.unit !== undefined)           out.unit = partial.unit
  if (partial.purchase_price !== undefined) out.purchase_price = hryvniaToKopecks(partial.purchase_price)
  if (partial.retail_price !== undefined)   out.retail_price = hryvniaToKopecks(partial.retail_price)
  if (partial.qty_on_hand !== undefined)    out.qty_on_hand = parseFloat(partial.qty_on_hand || '0')
  if (partial.reorder_point !== undefined)  out.reorder_point = parseFloat(partial.reorder_point || '0')
  if (partial.notes !== undefined)          out.notes = partial.notes || null
  if (partial.is_active !== undefined)      out.is_active = partial.is_active
  if (partial.storage_bin !== undefined)    out.storage_bin = partial.storage_bin || null
  if (partial.is_favorite !== undefined)    out.is_favorite = partial.is_favorite
  if (partial.specs !== undefined)          out.specs = cleanSpecs(partial.specs)
  if (partial.photo_url !== undefined)      out.photo_url = partial.photo_url || null
  return out
}

export const productApi = {
  list: (filters: ProductFilters = {}) =>
    api.get<PaginatedProducts>(`/api/v1/products${buildQuery(filters)}`),

  get: (id: string) =>
    api.get<{ data: Product }>(`/api/v1/products/${id}`),

  search: (q: string, limit = 10) =>
    api.get<{ data: Product[] }>(`/api/v1/products/search?q=${encodeURIComponent(q)}&limit=${limit}`),

  create: (form: ProductFormData) =>
    api.post<{ data: Product }>('/api/v1/products', formToCreatePayload(form)),

  update: (id: string, form: Partial<ProductFormData>) =>
    api.put<{ data: Product }>(`/api/v1/products/${id}`, formToUpdatePayload(form)),

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

  generateBarcodeOnly: () =>
    api.get<{ data: { barcode: string } }>('/api/v1/products/generate-barcode-only'),
}
