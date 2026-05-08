import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import type { OpenShiftInput, CloseShiftInput } from '../validators/shiftSchema.js'

const TABLE = 'shifts'

export async function getCurrentShift(cashierId: string) {
  const { data } = await db
    .from(TABLE)
    .select('*')
    .eq('cashier_id', cashierId)
    .eq('status', 'open')
    .maybeSingle()
  return data  // null якщо немає відкритої зміни
}

export async function getShift(id: string) {
  const { data, error } = await db
    .from(TABLE)
    .select('*')
    .eq('id', id)
    .single()

  if (error || !data) throw new AppError('SHIFT_NOT_FOUND', 'Зміну не знайдено', 404)
  return data
}

export async function openShift(cashierId: string, input: OpenShiftInput) {
  const existing = await getCurrentShift(cashierId)
  if (existing) throw new AppError('SHIFT_ALREADY_OPEN', 'У вас вже є відкрита зміна', 409)

  const { data, error } = await db
    .from(TABLE)
    .insert({
      tenant_id:     '00000000-0000-0000-0000-000000000001',
      cashier_id:    cashierId,
      status:        'open',
      opening_cash:  input.opening_cash,
      notes:         input.notes ?? null,
    })
    .select('*')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function closeShift(shiftId: string, cashierId: string, input: CloseShiftInput) {
  const shift = await getShift(shiftId)

  if (shift.cashier_id !== cashierId) {
    throw new AppError('FORBIDDEN', 'Це не ваша зміна', 403)
  }
  if (shift.status === 'closed') {
    throw new AppError('SHIFT_ALREADY_CLOSED', 'Зміна вже закрита', 409)
  }

  // Рахуємо очікуваний залишок готівки
  const { data: sales } = await db
    .from('sales')
    .select('total, payment_method')
    .eq('shift_id', shiftId)
    .eq('status', 'completed')

  const cashSales = (sales ?? [])
    .filter((s) => s.payment_method === 'cash')
    .reduce((sum, s) => sum + s.total, 0)

  const expectedCash = shift.opening_cash + cashSales
  const variance     = input.closing_cash - expectedCash

  const { data, error } = await db
    .from(TABLE)
    .update({
      status:        'closed',
      closing_cash:  input.closing_cash,
      expected_cash: expectedCash,
      cash_variance: variance,
      closed_at:     new Date().toISOString(),
      notes:         input.notes ?? shift.notes,
    })
    .eq('id', shiftId)
    .select('*')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function getShiftReport(shiftId: string) {
  const shift = await getShift(shiftId)

  const { data: sales } = await db
    .from('sales')
    .select('id, sale_number, total, payment_method, status, completed_at')
    .eq('shift_id', shiftId)
    .order('completed_at', { ascending: true })

  const list = sales ?? []
  const completed = list.filter((s) => s.status === 'completed')

  const total_revenue = completed.reduce((s, x) => s + x.total, 0)
  const by_method = {
    cash: completed.filter((s) => s.payment_method === 'cash').reduce((s, x) => s + x.total, 0),
    card: completed.filter((s) => s.payment_method === 'card').reduce((s, x) => s + x.total, 0),
    debt: completed.filter((s) => s.payment_method === 'debt').reduce((s, x) => s + x.total, 0),
  }

  return { shift, total_sales: completed.length, total_revenue, by_method, sales: list }
}

