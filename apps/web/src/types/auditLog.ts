export interface AuditLog {
  id:           string
  user_id:      string
  user_name:    string
  action:       string
  entity_type:  string
  entity_id:    string | null
  entity_label: string | null
  old_value:    Record<string, unknown> | null
  new_value:    Record<string, unknown> | null
  note:         string | null
  created_at:   string
}

export interface PaginatedAuditLog {
  data:       AuditLog[]
  pagination: { page: number; per_page: number; total: number; total_pages: number }
}

export const ACTION_LABEL: Record<string, string> = {
  'sale.created':          'Продаж',
  'sale.returned':         'Повернення',
  'product.price_changed': 'Зміна ціни',
  'writeoff.created':      'Списання',
}

export const ACTION_COLOR: Record<string, string> = {
  'sale.created':          'green',
  'sale.returned':         'orange',
  'product.price_changed': 'blue',
  'writeoff.created':      'red',
}
