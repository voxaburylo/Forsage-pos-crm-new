import { z } from 'zod'

export const saleItemSchema = z.object({
  product_id: z.string().uuid(),
  qty:        z.number().positive(),
  unit_price: z.number().int().positive(),   // копейки — береться з товару
  discount:   z.number().int().min(0).default(0),  // копейки
})

export const createSaleSchema = z.object({
  shift_id:       z.string().uuid(),
  customer_id:    z.string().uuid().optional().nullable(),
  items:          z.array(saleItemSchema).min(1, 'Чек не може бути порожнім'),
  payment_method: z.enum(['cash', 'card', 'debt']),
  discount:       z.number().int().min(0).default(0),  // знижка на весь чек (копейки)
  notes:          z.string().max(500).optional(),
})

export const calculatePriceSchema = z.object({
  items: z.array(z.object({
    product_id: z.string().uuid(),
    qty:        z.number().positive(),
  })).min(1),
})

export const saleListSchema = z.object({
  shift_id:    z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
  sale_number: z.string().optional(),
  date_from:   z.string().optional(),
  date_to:     z.string().optional(),
  page:        z.coerce.number().int().min(1).default(1),
  per_page:    z.coerce.number().int().min(1).max(100).default(20),
})

export type CreateSaleInput     = z.infer<typeof createSaleSchema>
export type CalculatePriceInput = z.infer<typeof calculatePriceSchema>
export type SaleListQuery       = z.infer<typeof saleListSchema>
