import { z } from 'zod'

export const cashOperationTypeEnum = z.enum(['in', 'out'])
export type CashOperationType = z.infer<typeof cashOperationTypeEnum>

export const createCashOperationSchema = z.object({
  type:               cashOperationTypeEnum,
  amount:             z.number().int().positive('Сума має бути більше 0'),
  note:               z.string().max(500).optional().nullable(),
  expense_category_id: z.string().uuid().optional().nullable(),
})

export const cashOpListSchema = z.object({
  shift_id: z.string().uuid().optional(),
  page:     z.coerce.number().int().positive().default(1),
  per_page: z.coerce.number().int().positive().max(100).default(50),
})

export type CreateCashOperationInput = z.infer<typeof createCashOperationSchema>
export type CashOpListQuery = z.infer<typeof cashOpListSchema>