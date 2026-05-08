export interface SalesSummary {
  total_sales: number
  total_revenue: number   // копійки
  by_method: {
    cash: number
    card: number
    debt: number
  }
}

export interface SalesPeriodReport extends SalesSummary {
  sales: Array<{
    id: string
    sale_number: string
    total: number
    payment_method: string
    status: string
    completed_at: string
    customer?: { id: string; phone: string; full_name: string | null } | null
  }>
}

export interface LowStockProduct {
  id: string
  sku: string
  name: string
  qty_on_hand: number
  reorder_point: number
  unit: string
  brand?: { name: string } | null
  category?: { name: string } | null
}

export interface Debtor {
  id: string
  phone: string
  full_name: string | null
  debt_balance: number    // копійки
}
