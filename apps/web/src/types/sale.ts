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
  shift_id: string
  status: 'completed' | 'returned' | 'voided'
  subtotal: number     // копійки
  discount: number     // копійки
  total: number        // копійки
  payment_method: 'cash' | 'card' | 'debt'
  is_debt: boolean
  notes: string | null
  completed_at: string
  sale_items?: SaleItem[]
  customer?: { id: string; phone: string; full_name: string | null } | null
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
