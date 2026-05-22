import { api } from '@/lib/api'
import type { SupplyInvoice } from '@/types/supplier'

export interface ParsedItem {
  row:           number
  sku:           string
  name:          string
  qty:           number
  price:         number
  matched:       boolean
  product_id:    string | null
  match_quality: 'exact' | 'fuzzy' | 'new'
  warnings:      string[]
}

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
    items:          Array<{ row: number; sku: string; name: string; qty: number; price: number; matched: boolean; product_id: string | null; match_quality: string; warnings: string[] }>
    supplier_id?:   string | null
    invoice_number?: string | null
    notes?:         string | null
    create_missing?: boolean
  }) =>
    api.post<{ data: SupplyInvoice }>('/api/v1/import/confirm', body),
}
