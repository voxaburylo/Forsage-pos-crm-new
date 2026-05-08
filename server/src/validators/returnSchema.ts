import { z } from 'zod'

export const createReturnSchema = z.object({
  sale_id:       z.string().uuid('Невірний ID чека'),
  reason:        z.enum(['defective', 'wrong_part', 'changed_mind', 'other'], {
    errorMap: () => ({ message: 'Вкажіть причину повернення' }),
  }),
  reason_note:   z.string().max(500).optional(),
  refund_method: z.enum(['cash', 'debt_reduction'], {
    errorMap: () => ({ message: 'Вкажіть метод повернення коштів' }),
  }),
})

export const returnListSchema = z.object({
  page:     z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
})

export type CreateReturnInput = z.infer<typeof createReturnSchema>
export type ReturnListQuery   = z.infer<typeof returnListSchema>
