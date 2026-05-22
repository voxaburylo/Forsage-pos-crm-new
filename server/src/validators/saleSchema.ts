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
  manager_id:     z.string().uuid().optional().nullable(),
  items:          z.array(saleItemSchema).min(1, 'Чек не може бути порожнім'),
  payment_method: z.enum(['cash', 'card', 'debt', 'mixed', 'transfer']),
  is_fiscal:      z.boolean().default(false),
  discount:       z.number().int().min(0).default(0),  // знижка на весь чек (копейки)
  notes:          z.string().max(500).optional(),
  cash_amount:    z.number().int().min(0).default(0),
  card_amount:    z.number().int().min(0).default(0),
  pickup_cell:    z.string().max(50).optional().nullable(),
  bonuses_spent:  z.number().int().min(0).default(0),
  terminal_auth_code: z.string().max(20).optional().nullable(),
}).refine(
  (data) => {
    if (data.payment_method === 'debt') {
      return !!data.customer_id
    }
    if (data.payment_method === 'mixed') {
      return data.cash_amount + data.card_amount > 0
    }
    return true
  },
  {
    message: 'При змішаній оплаті суми готівки та картки мають бути більше 0',
    path: ['cash_amount'],
  },
)

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
