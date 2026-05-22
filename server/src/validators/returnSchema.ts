import { z } from 'zod'

export const RETURN_REASONS = ['defective','wrong_part','changed_mind','warranty','duplicate','other'] as const
export const REFUND_METHODS  = ['cash','terminal','debt_reduction','credit'] as const
export const STOCK_ACTIONS   = ['return_to_stock','write_off','send_to_supplier'] as const
export const ITEM_CONDITIONS = ['good','damaged','opened_packaging','defective'] as const

// Який stock_action ДОЗВОЛЕНИЙ для кожного condition
export const CONDITION_ALLOWED_ACTIONS: Record<string, readonly string[]> = {
  good:              ['return_to_stock', 'write_off', 'send_to_supplier'],
  damaged:           ['return_to_stock', 'write_off', 'send_to_supplier'],
  opened_packaging:  ['return_to_stock', 'write_off', 'send_to_supplier'],
  defective:         ['write_off', 'send_to_supplier'],  // брак НЕ МОЖНА на склад
}

// Stock_action за замовчуванням для кожного condition
export const DEFAULT_STOCK_ACTION_FOR_CONDITION: Record<string, string> = {
  good:             'return_to_stock',
  damaged:          'return_to_stock',
  opened_packaging: 'return_to_stock',
  defective:        'write_off',
}

const returnItemSchema = z.object({
  sale_item_id: z.string().uuid(),
  product_id:   z.string().uuid(),
  quantity:     z.number().positive(),
  condition:    z.enum(ITEM_CONDITIONS).default('good'),
})

export const createReturnSchema = z.object({
  sale_id:       z.string().uuid(),
  reason:        z.enum(RETURN_REASONS),
  reason_note:   z.string().max(500).optional().nullable(),
  refund_method: z.enum(REFUND_METHODS),
  stock_action:  z.enum(STOCK_ACTIONS).default('return_to_stock'),
  items:         z.array(returnItemSchema).min(1),
})

export const returnListSchema = z.object({
  page:     z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
})

export type CreateReturnInput = z.infer<typeof createReturnSchema>
export type ReturnListQuery   = z.infer<typeof returnListSchema>