export interface SaleItem {
  id: string
  product_id: string
  qty: number
  unit_price: number   // копійки
  discount: number     // копійки
  total: number        // копійки
  product?: { id: string; sku: string; name: string; unit: string; qty_on_hand?: number }
  core_deposit_amount?: number
  core_return_status?: string
}

export interface Sale {
  id: string
  sale_number: string
  customer_id: string | null
  cashier_id: string
  manager_id: string | null
  shift_id: string
  status: 'completed' | 'returned' | 'voided' | 'suspended' | 'draft' | 'ready_for_pickup' | 'cancelled'
  subtotal: number     // копійки
  discount: number     // копійки
  total: number        // копійки
  payment_method: 'cash' | 'card' | 'debt' | 'mixed' | 'transfer'
  is_debt: boolean
  notes: string | null
  completed_at: string
  is_fiscal: boolean
  fiscal_number: string | null
  fiscal_qr_url?: string | null
  fiscal_status?: 'not_requested' | 'pending' | 'completed' | 'failed'
  fiscal_error?: string | null
  post_processing_warning?: string | null
  bank_auth_code: string | null
  cash_amount: number
  card_amount: number
  transfer_amount?: number
  debt_amount?: number
  is_order_sale?: boolean | number
  pickup_cell: string | null
  sale_items?: SaleItem[]
  customer?: { id: string; phone: string; full_name: string | null } | null
  manager?: { id: string; full_name: string } | null
  /** Повернення по цьому чеку (з фіскальними номерами чеків повернення ПРРО) */
  returns?: Array<{
    id: string
    refund_kopecks: number
    refund_method: string
    fiscal_number: string | null
    created_at: string
  }>
}

export interface PriceCalculation {
  product_id: string
  sku: string
  name: string
  unit: string
  unit_price: number
  qty: number
  total: number
  in_stock: boolean
  qty_on_hand: number
}
