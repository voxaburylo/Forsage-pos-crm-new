import { z } from 'zod'

export const NOTE_COLORS = ['yellow', 'red', 'green', 'blue'] as const

export const createNoteSchema = z.object({
  text:      z.string().min(1).max(1000),
  is_pinned: z.boolean().default(false),
  color:     z.enum(NOTE_COLORS).default('yellow'),
})

export const updateNoteSchema = z.object({
  text:      z.string().min(1).max(1000).optional(),
  is_pinned: z.boolean().optional(),
  color:     z.enum(NOTE_COLORS).optional(),
})

export type CreateNoteInput = z.infer<typeof createNoteSchema>
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>
