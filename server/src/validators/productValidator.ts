import { z } from 'zod'

// Нормализация артикула (по ТЗ раздел 13.1)
export function normalizeArticle(raw: string): string {
  return raw.replace(/[\s\-\.\/\_]/g, '').toUpperCase().replace(/^0+/, '') || raw.toUpperCase()
}

export const createProductSchema = z.object({
  sku: z.string().min(1).max(50).transform(normalizeArticle),
  name: z.string().min(2).max(500),
  barcode: z.string().max(100).optional().nullable(),
  brand_id: z.string().uuid().optional().nullable(),
  category_id: z.string().uuid().optional().nullable(),
  unit: z.enum(['шт', 'л', 'кг', 'м', 'компл']).default('шт'),
  purchase_price: z.number().int().min(0),   // копейки
  retail_price: z.number().int().min(0),     // копейки
  qty_on_hand: z.number().min(0).default(0),
  reorder_point: z.number().min(0).default(0),
  notes: z.string().max(2000).optional().nullable(),
  is_active: z.boolean().default(true),
})

export const updateProductSchema = createProductSchema.partial()

export const productListSchema = z.object({
  search: z.string().optional(),
  category_id: z.string().uuid().optional(),
  brand_id: z.string().uuid().optional(),
  is_active: z.enum(['true', 'false']).optional(),
  low_stock: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
})

export const posSearchSchema = z.object({
  q: z.string().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(20).default(10),
})

export type CreateProductInput = z.infer<typeof createProductSchema>
export type UpdateProductInput = z.infer<typeof updateProductSchema>
export type ProductListQuery = z.infer<typeof productListSchema>
