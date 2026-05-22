export interface Product {
  id: string
  sku: string
  name: string
  barcode: string | null
  brand_id: string | null
  category_id: string | null
  unit: string
  purchase_price: number   // копійки
  retail_price: number     // копійки
  qty_on_hand: number
  reorder_point: number
  notes: string | null
  is_active: boolean
  storage_bin: string | null
  is_favorite: boolean | null
  photo_url: string | null
  specs: Record<string, string> | null   // технічні характеристики
  created_at: string
  updated_at: string
  brand?: { id: string; name: string } | null
  category?: { id: string; name: string } | null
  qty_reserved?: number
  qty_available?: number
}

export interface ProductFormData {
  sku: string
  name: string
  barcode: string
  brand_id: string
  category_id: string
  unit: 'шт' | 'л' | 'кг' | 'м' | 'компл'
  purchase_price: string
  retail_price: string
  qty_on_hand: string
  reorder_point: string
  notes: string
  is_active: boolean
  storage_bin: string
  is_favorite: boolean
  photo_url?: string
  specs: Record<string, string>   // технічні характеристики
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
export const hryvniaToKopecks = (s: string | number | undefined): number => {
  if (s === undefined || s === '') return 0
  const n = typeof s === 'number' ? s : parseFloat(String(s).replace(',', '.'))
  return isNaN(n) ? 0 : Math.round(n * 100)
}

export function stockStatus(product: Product): 'ok' | 'low' | 'out' {
  const qty = product.qty_available ?? product.qty_on_hand
  if (qty <= 0) return 'out'
  if (qty <= product.reorder_point) return 'low'
  return 'ok'
}
