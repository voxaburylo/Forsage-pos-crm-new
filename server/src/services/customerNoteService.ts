import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import type { CreateNoteInput, UpdateNoteInput } from '../validators/customerNoteSchema.js'

const TABLE = 'customer_notes'

export async function listNotes(customerId: string, tenantId: string) {
  const { data, error } = await db
    .from(TABLE)
    .select('*')
    .eq('customer_id', customerId)
    .eq('tenant_id', tenantId)
    .order('is_pinned', { ascending: false })
    .order('created_at', { ascending: false })

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

export async function createNote(customerId: string, userId: string, input: CreateNoteInput, tenantId: string) {
  // Fetch tenant_id dynamically from customer record to maintain multi-tenant integrity and verify ownership
  const { data: customer } = await db
    .from('customers')
    .select('tenant_id')
    .eq('id', customerId)
    .eq('tenant_id', tenantId)
    .single()

  if (!customer) {
    throw new AppError('NOT_FOUND', 'Клієнта не знайдено в цьому магазині', 404)
  }

  const { data, error } = await db
    .from(TABLE)
    .insert({
      tenant_id:   tenantId,
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

export async function updateNote(noteId: string, customerId: string, input: UpdateNoteInput, tenantId: string) {
  const { data, error } = await db
    .from(TABLE)
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', noteId)
    .eq('customer_id', customerId)
    .eq('tenant_id', tenantId)
    .select('*')
    .single()

  if (error || !data) throw new AppError('NOT_FOUND', 'Нотатку не знайдено', 404)
  return data
}

export async function deleteNote(noteId: string, customerId: string, tenantId: string) {
  const { error } = await db
    .from(TABLE)
    .delete()
    .eq('id', noteId)
    .eq('customer_id', customerId)
    .eq('tenant_id', tenantId)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

export async function getPinnedNotes(customerId: string, tenantId: string) {
  const { data, error } = await db
    .from(TABLE)
    .select('*')
    .eq('customer_id', customerId)
    .eq('tenant_id', tenantId)
    .eq('is_pinned', true)
    .order('created_at', { ascending: false })

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}
