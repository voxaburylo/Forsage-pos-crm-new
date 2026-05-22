import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import type { CreateNoteInput, UpdateNoteInput } from '../validators/customerNoteSchema.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'
const TABLE = 'customer_notes'

export async function listNotes(customerId: string) {
  const { data, error } = await db
    .from(TABLE)
    .select('*')
    .eq('customer_id', customerId)
    .order('is_pinned', { ascending: false })
    .order('created_at', { ascending: false })

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

export async function createNote(customerId: string, userId: string, input: CreateNoteInput) {
  const { data, error } = await db
    .from(TABLE)
    .insert({
      tenant_id:   TENANT_ID,
      customer_id: customerId,
      created_by:  userId,
      text:        input.text,
      is_pinned:   input.is_pinned,
      color:       input.color,
    })
    .select('*')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function updateNote(noteId: string, customerId: string, input: UpdateNoteInput) {
  const { data, error } = await db
    .from(TABLE)
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', noteId)
    .eq('customer_id', customerId)
    .select('*')
    .single()

  if (error || !data) throw new AppError('NOT_FOUND', 'Нотатку не знайдено', 404)
  return data
}

export async function deleteNote(noteId: string, customerId: string) {
  const { error } = await db
    .from(TABLE)
    .delete()
    .eq('id', noteId)
    .eq('customer_id', customerId)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

export async function getPinnedNotes(customerId: string) {
  const { data, error } = await db
    .from(TABLE)
    .select('*')
    .eq('customer_id', customerId)
    .eq('is_pinned', true)
    .order('created_at', { ascending: false })

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}
