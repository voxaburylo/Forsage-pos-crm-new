import { request } from '@/lib/api'
import { mirrorProductToDesktop, requestDesktopSync } from '@/features/products/productApi'
import type { Product } from '@/types/product'

export interface SupplierPriceImport {
  id:             string
  tenant_id:      string
  supplier_id:    string | null
  filename:       string
  status:         'pending' | 'processing' | 'completed' | 'failed'
  total_rows:     number
  processed_rows: number
  errors_log:     Array<{ row: number; error: string; raw?: string }>
  created_at:     string
  updated_at:     string
  suppliers?: {
    id:   string
    name: string
  }
}

export interface SupplierCatalogItem {
  id:             string
  sku:            string
  brand:          string | null
  name:           string
  price_kopecks:  number
  qty:            string
  warehouse_name: string | null
  supplier?: {
    id:   string
    name: string
  }
}

export const supplierImportsApi = {
  upload: (file: File, supplierId: string | null, updateRetail: boolean, mode: 'replace' | 'add', warehouseName?: string) => {
    const query = new URLSearchParams()
    if (supplierId) query.append('supplier_id', supplierId)
    query.append('update_retail', String(updateRetail))
    query.append('mode', mode)
    if (warehouseName) query.append('warehouse_name', warehouseName)

    return request<{ success: boolean; importId: string }>(
      '/api/v1/supplier-imports/upload?' + query.toString(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/csv',
          'X-Filename': encodeURIComponent(file.name),
        },
        body: file,
      }
    )
  },

  getStatus: (id: string) =>
    request<{ data: SupplierPriceImport }>('/api/v1/supplier-imports/status/' + id),

  list: () =>
    request<{ data: SupplierPriceImport[] }>('/api/v1/supplier-imports'),

  createCatalogItem: (body: { sku: string; brand?: string; name: string; price_kopecks: number; qty?: string; warehouse_name?: string; supplier_id?: string | null }) =>
    request<{ data: SupplierCatalogItem }>('/api/v1/search/catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  updateCatalogItem: (id: string, body: Partial<SupplierCatalogItem> & { supplier_id?: string | null }) =>
    request<{ data: SupplierCatalogItem }>('/api/v1/search/catalog/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  deleteCatalogItem: (id: string) =>
    request<void>('/api/v1/search/catalog/' + id, {
      method: 'DELETE',
    }),

  getCatalog: (params: { q?: string; supplier_id?: string; page?: number; limit?: number }) => {
    const query = new URLSearchParams()
    if (params.q) query.append('q', params.q)
    if (params.supplier_id) query.append('supplier_id', params.supplier_id)
    if (params.page) query.append('page', String(params.page))
    if (params.limit) query.append('limit', String(params.limit))

    return request<{ data: SupplierCatalogItem[]; pagination: { page: number; limit: number; total: number } }>(
      '/api/v1/search/catalog?' + query.toString()
    )
  },

  importOnDemand: async (input: { sku: string; brand: string; name: string; supplier_id: string | null; purchase_price: number; retail_price?: number }) => {
    const response = await request<{ data: Product }>('/api/v1/search/import-on-demand', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    })
    if (response.data) {
      await mirrorProductToDesktop(response.data)
      requestDesktopSync()
    }
    return response
  }
}
