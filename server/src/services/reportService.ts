import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import type { PeriodQuery } from '../validators/reportSchema.js'

function todayRange(): { from: string; to: string } {
  const now = new Date()
  const date = now.toISOString().split('T')[0]
  return { from: `${date}T00:00:00.000Z`, to: `${date}T23:59:59.999Z` }
}

function buildSummary(sales: Array<{ total: number; payment_method: string }>) {
  return {
    total_sales:   sales.length,
    total_revenue: sales.reduce((s, x) => s + x.total, 0),
    by_method: {
      cash: sales.filter((s) => s.payment_method === 'cash').reduce((s, x) => s + x.total, 0),
      card: sales.filter((s) => s.payment_method === 'card').reduce((s, x) => s + x.total, 0),
      debt: sales.filter((s) => s.payment_method === 'debt').reduce((s, x) => s + x.total, 0),
    },
  }
}

export async function getSalesToday() {
  const { from, to } = todayRange()

  const { data, error } = await db
    .from('sales')
    .select('total, payment_method')
    .gte('completed_at', from)
    .lte('completed_at', to)
    .eq('status', 'completed')

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return buildSummary(data ?? [])
}

export async function getSalesPeriod(query: PeriodQuery) {
  const { from, to } = todayRange()
  const dateFrom = query.from ? `${query.from}T00:00:00.000Z` : from
  const dateTo   = query.to   ? `${query.to}T23:59:59.999Z`   : to

  const { data, error } = await db
    .from('sales')
    .select('id, sale_number, total, payment_method, status, completed_at, customer:customers(id,phone,full_name)')
    .gte('completed_at', dateFrom)
    .lte('completed_at', dateTo)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  const list = data ?? []
  return { ...buildSummary(list), sales: list }
}

export async function getLowStockProducts() {
  // PostgREST не вміє порівнювати дві колонки → фільтруємо в JS
  const { data, error } = await db
    .from('products')
    .select('id, sku, name, qty_on_hand, reorder_point, unit, brand:brands(name), category:categories(name)')
    .is('deleted_at', null)
    .eq('is_active', true)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return (data ?? [])
    .filter((p) => p.qty_on_hand <= p.reorder_point)
    .sort((a, b) => a.qty_on_hand - b.qty_on_hand)
}

export async function getDebtors() {
  const { data, error } = await db
    .from('customers')
    .select('id, phone, full_name, debt_balance')
    .is('deleted_at', null)
    .gt('debt_balance', 0)
    .order('debt_balance', { ascending: false })

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

export async function getShiftReport(shiftId: string) {
  const { data: shift, error: shiftError } = await db
    .from('shifts')
    .select('*')
    .eq('id', shiftId)
    .single()

  if (shiftError || !shift) throw new AppError('SHIFT_NOT_FOUND', 'Зміну не знайдено', 404)

  const { data: sales } = await db
    .from('sales')
    .select('id, sale_number, total, payment_method, status, completed_at')
    .eq('shift_id', shiftId)
    .order('completed_at', { ascending: true })

  const list = sales ?? []
  const completed = list.filter((s) => s.status === 'completed')

  return {
    shift,
    total_sales:   completed.length,
    total_revenue: completed.reduce((s, x) => s + x.total, 0),
    by_method: {
      cash: completed.filter((s) => s.payment_method === 'cash').reduce((s, x) => s + x.total, 0),
      card: completed.filter((s) => s.payment_method === 'card').reduce((s, x) => s + x.total, 0),
      debt: completed.filter((s) => s.payment_method === 'debt').reduce((s, x) => s + x.total, 0),
    },
    sales: list,
  }
}
