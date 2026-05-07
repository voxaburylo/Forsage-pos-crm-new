export interface Product {
  id: string
  tenant_id: string
  sku: string
  name: string
  barcode: string | null
  brand_id: string | null
  category_id: string | null
  unit: string
  purchase_price: number   // копейки
  retail_price: number     // копейки
  qty_on_hand: number
  reorder_point: number
  notes: string | null
  is_active: boolean
  created_at: string
  updated_at: string
  deleted_at: string | null
  // joins
  brand?: { id: string; name: string } | null
  category?: { id: string; name: string } | null
}

export interface PaginatedResponse<T> {
  data: T[]
  pagination: {
    page: number
    per_page: number
    total: number
    total_pages: number
  }
}
