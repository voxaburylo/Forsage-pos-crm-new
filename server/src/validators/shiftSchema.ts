import { z } from 'zod'

export const openShiftSchema = z.object({
  opening_cash: z.number().int().min(0, 'Сума не може бути від\'ємною'),  // копейки
  notes:        z.string().max(500).optional(),
})

export const closeShiftSchema = z.object({
  closing_cash: z.number().int().min(0, 'Сума не може бути від\'ємною'),  // копейки
  notes:        z.string().max(500).optional(),
})

export type OpenShiftInput  = z.infer<typeof openShiftSchema>
export type CloseShiftInput = z.infer<typeof closeShiftSchema>
