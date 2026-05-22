import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import { logAction } from './auditService.js'
import type { CreateCashOperationInput, CashOpListQuery } from '../validators/cashOperationSchema.js'

const TABLE = 'cash_operations'

export async function createCashOperation(
  input:    CreateCashOperationInput,
  shiftId:  string | null,
  userId:   string,
  userRole: string,
  tenantId: string,
) {
  // Якщо shift_id не передано — це операція поза зміною (напр. витрати)
  if (shiftId) {
    const { data: shift } = await db
      .from('shifts')
      .select('id, status')
      .eq('id', shiftId)
      .single()
    if (!shift) throw new AppError('SHIFT_NOT_FOUND', 'Зміну не знайдено', 404)
    if (shift.status === 'closed') throw new AppError('SHIFT_CLOSED', 'Зміна вже закрита', 409)
  }

  const { data, error } = await db
    .from(TABLE)
    .insert({
      tenant_id:  tenantId,
      shift_id:   shiftId,
      type:       input.type,
      amount:             input.amount,
      note:               input.note ?? null,
      expense_category_id: input.expense_category_id ?? null,
      created_by:         userId,
    })
    .select('*')
    .single()

  if (error || !data) throw new AppError('DB_ERROR', error?.message ?? 'Create failed', 500)

  const label = input.type === 'in' ? 'Внесення' : 'Виймання'
  void logAction({
    userId,
    userRole,
    action:      'cash_operation_' + input.type,
    entityType:  'cash_operation',
    entityId:    data.id,
    note:        label + ' ' + Math.round(input.amount / 100) + ' грн',
  })

  return data
}

export async function listCashOperations(query: CashOpListQuery) {
  let q = db
    .from(TABLE)
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })

  if (query.shift_id) q = q.eq('shift_id', query.shift_id)

  const from = (query.page - 1) * query.per_page
  q = q.range(from, from + query.per_page - 1)

  const { data, error, count } = await q
  if (error) throw new AppError('DB_ERROR', error.message, 500)

  return {
    data:     data ?? [],
    total:    count ?? 0,
    page:     query.page,
    per_page: query.per_page,
  }
}

export async function getShiftCashSummary(shiftId: string) {
  const { data, error } = await db
    .from(TABLE)
    .select('type, amount')
    .eq('shift_id', shiftId)

  if (error) throw new AppError('DB_ERROR', error.message, 500)

  const ops     = data ?? []
  const totalIn  = ops.filter((o) => o.type === 'in').reduce((s, o) => s + o.amount, 0)
  const totalOut = ops.filter((o) => o.type === 'out').reduce((s, o) => s + o.amount, 0)

  return { total_in: totalIn, total_out: totalOut, net: totalIn - totalOut }
}
