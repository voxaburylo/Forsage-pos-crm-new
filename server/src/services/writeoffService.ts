import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import { logAction } from './auditService.js'
import type { CreateWriteoffInput, WriteoffListQuery } from '../validators/writeoffSchema.js'

const TABLE = 'inventory_writeoffs'

export async function listWriteoffs(query: WriteoffListQuery) {
  const { reason, page, per_page } = query
  const offset = (page - 1) * per_page

  let q = db
    .from(TABLE)
    .select('*, items:inventory_writeoff_items(*, product:products(id,sku,name,unit))', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + per_page - 1)

  if (reason) q = q.eq('reason', reason)

  const { data, error, count } = await q
  if (error) throw new AppError('DB_ERROR', error.message, 500)

  return {
    data: data ?? [],
    pagination: { page, per_page, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / per_page) },
  }
}

export async function getWriteoff(id: string) {
  const { data, error } = await db
    .from(TABLE)
    .select('*, items:inventory_writeoff_items(*, product:products(id,sku,name,unit))')
    .eq('id', id)
    .single()

  if (error || !data) throw new AppError('NOT_FOUND', 'Акт списання не знайдено', 404)
  return data
}

export async function createWriteoff(userId: string, tenantId: string, input: CreateWriteoffInput) {
  const { data, error } = await db.rpc('process_writeoff', {
    p_tenant_id:  tenantId,
    p_reason:     input.reason,
    p_notes:      input.notes ?? null,
    p_created_by: userId,
    p_items:      input.items
  })

  if (error) {
    if (error.message.includes('INSUFFICIENT_STOCK')) {
      throw new AppError('INSUFFICIENT_STOCK', error.message, 400)
    }
    if (error.message.includes('PRODUCT_NOT_FOUND')) {
      throw new AppError('PRODUCT_NOT_FOUND', error.message, 404)
    }
    throw new AppError('DB_ERROR', error.message, 500)
  }

  const writeoffId = (data as any).id

  void logAction({
    userId:      userId,
    userRole:    'storekeeper',
    action:      'writeoff.created',
    entityType:  'writeoff',
    entityId:    writeoffId,
    entityLabel: input.reason,
    newValue:    { items: input.items.length, reason: input.reason },
  })

  return getWriteoff(writeoffId)
}
