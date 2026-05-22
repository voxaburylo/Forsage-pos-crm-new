export interface Shift {
  id: string
  cashier_id: string
  status: 'open' | 'closed'
  opening_cash: number    // копійки
  closing_cash: number | null
  expected_cash: number | null
  cash_variance: number | null
  opened_at: string
  closed_at: string | null
  notes: string | null
}

export interface ShiftReportByUser {
  user_id: string
  cash_in: number
  cash_out: number
  count: number
}

export interface ShiftReport {
  shift: Shift
  total_sales: number
  total_revenue: number   // копійки
  by_method: {
    cash: number
    card: number
    debt: number
  }
  by_user?: ShiftReportByUser[]
  sales: Array<{
    id: string
    sale_number: string
    total: number
    payment_method: string
    status: string
    completed_at: string
  }>
}
