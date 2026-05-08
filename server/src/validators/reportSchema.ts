import { z } from 'zod'

export const periodSchema = z.object({
  from: z.string().optional(),
  to:   z.string().optional(),
})

export const shiftReportSchema = z.object({
  id: z.string().uuid('Невірний ID зміни'),
})

export type PeriodQuery = z.infer<typeof periodSchema>
