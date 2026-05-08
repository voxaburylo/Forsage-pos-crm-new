export type ReturnReason = 'defective' | 'wrong_part' | 'changed_mind' | 'other'
export type RefundMethod = 'cash' | 'debt_reduction'

export const RETURN_REASON_LABELS: Record<ReturnReason, string> = {
  defective:      'Бракована деталь',
  wrong_part:     'Не та деталь',
  changed_mind:   'Клієнт передумав',
  other:          'Інше',
}

export const REFUND_METHOD_LABELS: Record<RefundMethod, string> = {
  cash:           'Повернення готівкою',
  debt_reduction: 'Зменшення боргу',
}

export interface CustomerReturn {
  id: string
  sale_id: string
  customer_id: string | null
  return_type: string
  reason: ReturnReason
  reason_note: string | null
  refund_method: RefundMethod
  refund_kopecks: number
  stock_action: string
  status: string
  approved_by: string
  created_at: string
  sale?: { id: string; sale_number: string; total: number }
  customer?: { id: string; phone: string; full_name: string | null } | null
}

export interface PaginatedReturns {
  data: CustomerReturn[]
  pagination: {
    page: number
    per_page: number
    total: number
    total_pages: number
  }
}
