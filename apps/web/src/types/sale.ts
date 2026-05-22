export interface SaleItem {
  id: string
  product_id: string
  qty: number
  unit_price: number   // копійки
  discount: number     // копійки
  total: number        // копійки
  product?: { id: string; sku: string; name: string; unit: string }
}

export interface Sale {
  id: string
  sale_number: string
  customer_id: string | null
  cashier_id: string
  manager_id: string | null
  shift_id: string
  status: 'completed' | 'returned' | 'voided' | 'suspended' | 'draft' | 'ready_for_pickup'
  subtotal: number     // копійки
  discount: number     // копійки
  total: number        // копійки
  payment_method: 'cash' | 'card' | 'debt' | 'mixed' | 'transfer'
  is_debt: boolean
  notes: string | null
  completed_at: string
  is_fiscal: boolean
  fiscal_number: string | null
  bank_auth_code: string | null
  cash_amount: number
  card_amount: number
  pickup_cell: string | null
  sale_items?: SaleItem[]
  customer?: { id: string; phone: string; full_name: string | null } | null
  manager?: { id: string; full_name: string } | null
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
