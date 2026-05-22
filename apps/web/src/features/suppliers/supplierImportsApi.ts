import { request } from '@/lib/api'

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

export const supplierImportsApi = {
  upload: (file: File, supplierId: string | null, updateRetail: boolean, mode: 'replace' | 'add') => {
    const query = new URLSearchParams()
    if (supplierId) query.append('supplier_id', supplierId)
    query.append('update_retail', String(updateRetail))
    query.append('mode', mode)

    return request<{ success: boolean; importId: string; jobId: string }>(
      `/api/v1/supplier-imports/upload?${query.toString()}`,
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
    request<{ data: SupplierPriceImport }>(`/api/v1/supplier-imports/status/${id}`),

  list: () =>
    request<{ data: SupplierPriceImport[] }>('/api/v1/supplier-imports'),
}
