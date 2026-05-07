export interface Product {
  id: string
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
  brand?: { id: string; name: string } | null
  category?: { id: string; name: string } | null
}

export interface ProductFormData {
  sku: string
  name: string
  barcode: string
  brand_id: string
  category_id: string
  unit: 'шт' | 'л' | 'кг' | 'м' | 'компл'
  purchase_price: string   // строка в форме (грн)
  retail_price: string     // строка в форме (грн)
  qty_on_hand: string
  reorder_point: string
  notes: string
  is_active: boolean
}

export interface PaginatedProducts {
  data: Product[]
  pagination: {
    page: number
    per_page: number
    total: number
    total_pages: number
  }
}

// Утилиты для конвертации
export const kopecksToHryvnia = (k: number): string => (k / 100).toFixed(2)
export const hryvniaToKopecks = (s: string): number => Math.round(parseFloat(s || '0') * 100)

export function stockStatus(product: Product): 'ok' | 'low' | 'out' {
  if (product.qty_on_hand <= 0) return 'out'
  if (product.qty_on_hand <= product.reorder_point) return 'low'
  return 'ok'
}
