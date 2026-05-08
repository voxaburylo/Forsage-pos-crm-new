import { z } from 'zod'

const dateRegex = /^\d{4}-\d{2}-\d{2}$/

export const periodSchema = z.object({
  from: z.string().regex(dateRegex, 'Формат дати: YYYY-MM-DD').optional(),
  to:   z.string().regex(dateRegex, 'Формат дати: YYYY-MM-DD').optional(),
})

export const shiftReportSchema = z.object({
  id: z.string().uuid('Невірний ID зміни'),
})

export type PeriodQuery = z.infer<typeof periodSchema>
