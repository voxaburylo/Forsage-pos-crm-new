import { api } from '@/lib/api'
import type { SupplyInvoice } from '@/types/supplier'
import type { ParsedItem } from '@crm-forsage/shared'

export interface ParseResult {
  supplier_id:   string | null | undefined
  items:         ParsedItem[]
  total_items:   number
  matched_count: number
  new_count:     number
}

export const importApi = {
  parse: (body: { text: string; supplier_id?: string | null }) =>
    api.post<ParseResult>('/api/v1/import/parse', body),

  confirm: (body: {
    items:          ParsedItem[]
    supplier_id?:   string | null
    invoice_number?: string | null
    notes?:         string | null
    create_missing?: boolean
    update_retail?:  boolean
  }) =>
    api.post<{ data: SupplyInvoice }>('/api/v1/import/confirm', body),
}
