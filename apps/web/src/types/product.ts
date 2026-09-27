export interface Product {
  cross_numbers_count?: number
  id: string
  sku: string
  name: string
  barcode: string | null
  additional_barcodes?: string[] | null
  brand_id: string | null
  category_id: string | null
  unit: string
  purchase_price: number   // копійки
  retail_price: number     // копійки
  qty_on_hand: number
  reorder_point: number
  notes: string | null
  is_active: boolean
  is_service: boolean
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
  requires_core_return?: boolean
  core_deposit_amount?: number
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
  is_service?: boolean
  storage_bin: string
  is_favorite: boolean
  photo_url?: string | null
  specs: Record<string, string>   // технічні характеристики
  requires_core_return?: boolean
  core_deposit_amount?: string    // гривні (рядок форми)
  cross_numbers?: string          // аналоги/крос-номери через кому (рядок форми)
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

// A card may omit stock and hidden purchase price; documents own stock changes.
export type ProductCreateData = Omit<ProductFormData, 'qty_on_hand' | 'purchase_price'> &
  Partial<Pick<ProductFormData, 'qty_on_hand' | 'purchase_price'>>

// Утилиты для конвертации
export const kopecksToHryvnia = (k: number): string => (k / 100).toFixed(2)
export const hryvniaToKopecks = (s: string | number | undefined): number => {
  if (s === undefined || s === '') return 0
  let raw = typeof s === 'number' ? s : String(s).trim()
  if (typeof raw === 'string' && /^\d{1,3}(?:,\d{3})+\.\d{1,2}$/.test(raw)) raw = raw.replace(/,/g, '')
  else if (typeof raw === 'string' && /^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(raw)) raw = raw.replace(/\./g, '')
  if (typeof raw === 'string' && !/^(?:\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)(?:[.,]\d{1,2})?$/.test(raw))
    throw new Error('Некоректна ціна. Введіть гривні, наприклад 1250,50; не більше двох знаків після коми.')
  const n = typeof raw === 'number' ? raw : Number(raw.replace(/[ \u00a0\u202f]/g, '').replace(',', '.'))
  const kopecks = Math.round(n * 100)
  if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(kopecks) || kopecks > 2_147_483_647)
    throw new Error('Некоректна або завелика ціна. Перевірте, чи не введено штрихкод у поле ціни.')
  return kopecks
}

export function stockStatus(product: Product): 'ok' | 'low' | 'out' {
  const qty = product.qty_available ?? product.qty_on_hand
  if (qty <= 0) return 'out'
  if (qty <= product.reorder_point) return 'low'
  return 'ok'
}
