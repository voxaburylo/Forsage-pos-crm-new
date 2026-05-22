import { z } from 'zod'

// Нормализация артикула (по ТЗ раздел 13.1)
export function normalizeArticle(raw: string): string {
  return raw.replace(/[\s\-\.\/\_]/g, '').toUpperCase().replace(/^0+/, '') || raw.toUpperCase()
}

/** Нормалізація OEM/артикула постачальника для зберігання */
export function normalizeOemValue(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw.replace(/[\s\-\.\/\_]/g, '').toUpperCase()
}

/** Status товару (ТЗ Product Status Lifecycle) */
export const PRODUCT_STATUSES = ['draft', 'active', 'discontinued', 'archived', 'blocked'] as const
export type ProductStatus = (typeof PRODUCT_STATUSES)[number]

export const statusSchema = z.enum(PRODUCT_STATUSES)

export const createProductSchema = z.object({
  sku: z.string().min(1).max(50).transform(normalizeArticle),
  name: z.string().min(2).max(500),
  barcode: z.string().max(100).optional().nullable(),
  photo_url: z.string().max(500).optional().nullable(),
  oem_number: z.string().max(100).optional().nullable(),
  brand_id: z.string().uuid().optional().nullable(),
  category_id: z.string().uuid().optional().nullable(),
  unit: z.enum(['шт', 'л', 'кг', 'м', 'компл']).default('шт'),
  purchase_price: z.number().int().min(0),     // копійки
  retail_price: z.number().int().min(0),       // копійки
  wholesale_price: z.number().int().min(0).optional().default(0),  // копійки
  min_price: z.number().int().min(0).optional().default(0),        // копійки
  qty_on_hand: z.number().min(0).default(0),
  reorder_point: z.number().min(0).default(0),
  notes: z.string().max(2000).optional().nullable(),
  is_active: z.boolean().default(true),
  status: statusSchema.optional().default('active'),
  storage_bin: z.string().max(50).optional().nullable(),
  is_favorite: z.boolean().optional(),
  specs: z.record(z.string()).optional().nullable(),
})

export const updateProductSchema = createProductSchema.partial()

export const productListSchema = z.object({
  search: z.string().optional(),
  category_id: z.string().uuid().optional(),
  brand_id: z.string().uuid().optional(),
  is_active: z.enum(['true', 'false']).optional(),
  low_stock: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(2000).default(25),
  sort_field: z.enum(['sku', 'name', 'retail_price', 'qty_on_hand', 'created_at', 'brand']).optional(),
  sort_dir: z.enum(['asc', 'desc']).optional().default('asc'),
})

export const posSearchSchema = z.object({
  q: z.string().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(20).default(10),
})

export type CreateProductInput = z.infer<typeof createProductSchema>
export type UpdateProductInput = z.infer<typeof updateProductSchema>
export type ProductListQuery = z.infer<typeof productListSchema>

export const stockCorrectionSchema = z.object({
  qty_on_hand: z.number().min(0),
  reason: z.string().max(500).optional().default('Корекція залишку'),
})

export type StockCorrectionInput = z.infer<typeof stockCorrectionSchema>

export const addAnalogSchema = z.object({
  analog_product_id: z.string().uuid(),
  analog_type: z.enum(['substitute', 'oem', 'cross']).default('substitute'),
  priority: z.number().int().min(0).max(999).default(0),
})

export type AddAnalogInput = z.infer<typeof addAnalogSchema>
