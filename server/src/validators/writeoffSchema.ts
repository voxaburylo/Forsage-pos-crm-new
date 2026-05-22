import { z } from 'zod'

export const WRITEOFF_REASONS = ['damage', 'expiry', 'loss', 'audit', 'other'] as const
export type WriteoffReason = typeof WRITEOFF_REASONS[number]

export const createWriteoffSchema = z.object({
  reason: z.enum(WRITEOFF_REASONS),
  notes:  z.string().max(2000).optional().nullable(),
  items:  z.array(z.object({
    product_id: z.string().uuid(),
    qty:        z.number().positive(),
  })).min(1),
})

export const writeoffListSchema = z.object({
  reason:   z.enum(WRITEOFF_REASONS).optional(),
  page:     z.coerce.number().int().positive().default(1),
  per_page: z.coerce.number().int().positive().max(100).default(20),
})

export type CreateWriteoffInput = z.infer<typeof createWriteoffSchema>
export type WriteoffListQuery   = z.infer<typeof writeoffListSchema>
