export type WriteoffReason = 'damage' | 'expiry' | 'loss' | 'audit' | 'other'

export const REASON_LABEL: Record<WriteoffReason, string> = {
  damage: 'Пошкодження',
  expiry: 'Прострочення',
  loss:   'Нестача',
  audit:  'Інвентаризація',
  other:  'Інше',
}

export const REASON_COLOR: Record<WriteoffReason, 'red' | 'orange' | 'blue' | 'gray'> = {
  damage: 'red',
  expiry: 'orange',
  loss:   'red',
  audit:  'blue',
  other:  'gray',
}

export interface WriteoffItem {
  id:           string
  writeoff_id:  string
  product_id:   string
  qty:          number
  cost_kopecks: number
  created_at:   string
  product?:     { id: string; sku: string; name: string; unit: string } | null
}

export interface Writeoff {
  id:         string
  tenant_id:  string
  reason:     WriteoffReason
  notes:      string | null
  created_by: string
  created_at: string
  items?:     WriteoffItem[]
}

export interface PaginatedWriteoffs {
  data:       Writeoff[]
  pagination: { page: number; per_page: number; total: number; total_pages: number }
}
