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

  // 1. Отримуємо продажі за період
  const { data: sales, error: salesErr } = await db
    .from('sales')
    .select('id, sale_number, total, payment_method, status, completed_at, customer:customers(id,phone,full_name)')
    .gte('completed_at', dateFrom)
    .lte('completed_at', dateTo)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })

  if (salesErr) throw new AppError('DB_ERROR', salesErr.message, 500)

  const list = sales ?? []

  // 2. Розраховуємо прибуток (маржа) за позиціями продажів у періоді
  const saleIds = list.map((s) => s.id)
  let profit = 0

  if (saleIds.length > 0) {
    const { data: items, error: itemsErr } = await db
      .from('sale_items')
      .select('qty, unit_price, product:products!inner(purchase_price)')
      .in('sale_id', saleIds)

    if (itemsErr) throw new AppError('DB_ERROR', itemsErr.message, 500)

    for (const item of items ?? []) {
      const product = item.product as unknown as { purchase_price: number } | undefined
      const purchasePrice = product?.purchase_price ?? 0
      profit += (item.unit_price - purchasePrice) * item.qty
    }
  }

  return { ...buildSummary(list), profit, sales: list }
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

export async function getWeeklySales() {
  // Один запит замість 7 — групуємо в JS
  const weekAgo = new Date()
  weekAgo.setDate(weekAgo.getDate() - 6)
  const fromDate = weekAgo.toISOString().split('T')[0] + 'T00:00:00.000Z'
  const { to } = todayRange()

  const { data, error } = await db
    .from('sales')
    .select('completed_at, total')
    .gte('completed_at', fromDate)
    .lte('completed_at', to)
    .eq('status', 'completed')
    .order('completed_at', { ascending: true })

  if (error) throw new AppError('DB_ERROR', error.message, 500)

  // Групуємо по днях
  const daysMap = new Map<string, { date: string; revenue: number; sales: number }>()
  for (const s of data ?? []) {
    const date = s.completed_at.split('T')[0]
    const existing = daysMap.get(date) ?? { date, revenue: 0, sales: 0 }
    existing.revenue += s.total
    existing.sales++
    daysMap.set(date, existing)
  }

  // Заповнюємо 7 днів (включно з днями без продажів)
  const result: Array<{ date: string; revenue: number; sales: number }> = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const date = d.toISOString().split('T')[0]
    result.push(daysMap.get(date) ?? { date, revenue: 0, sales: 0 })
  }

  return result
}

export async function getTopProducts(query: PeriodQuery) {
  const { to } = todayRange()
  const dateFrom = query.from ? `${query.from}T00:00:00.000Z` : '1970-01-01T00:00:00.000Z'
  const dateTo   = query.to   ? `${query.to}T23:59:59.999Z`   : to

  // 1. Отримуємо ID продажів за період
  const { data: sales, error: salesErr } = await db
    .from('sales')
    .select('id')
    .gte('completed_at', dateFrom)
    .lte('completed_at', dateTo)
    .eq('status', 'completed')

  if (salesErr) throw new AppError('DB_ERROR', salesErr.message, 500)

  const saleIds = (sales ?? []).map((s) => s.id)
  if (saleIds.length === 0) return []

  // 2. Отримуємо всі sale_items з продуктами
  const { data: items, error: itemsErr } = await db
    .from('sale_items')
    .select('product_id, qty, unit_price, total, product:products!inner(sku, name)')
    .in('sale_id', saleIds)

  if (itemsErr) throw new AppError('DB_ERROR', itemsErr.message, 500)

  // 3. Групуємо по товару
  const grouped = new Map<string, {
    product_id: string
    sku: string
    name: string
    total_qty: number
    total_revenue: number
  }>()

  for (const item of items ?? []) {
    const p = item.product as unknown as { sku: string; name: string }
    const existing = grouped.get(item.product_id) ?? {
      product_id: item.product_id,
      sku: p?.sku ?? '',
      name: p?.name ?? '',
      total_qty: 0,
      total_revenue: 0,
    }
    existing.total_qty += item.qty
    existing.total_revenue += item.total
    grouped.set(item.product_id, existing)
  }

  // 4. Сортуємо за кількістю, беремо TOP-10
  return [...grouped.values()]
    .sort((a, b) => b.total_qty - a.total_qty)
    .slice(0, 10)
}

export async function getWriteoffsSummary() {
  const now = new Date()
  const year  = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const from  = year + '-' + month + '-01T00:00:00.000Z'

  const { data, error } = await db
    .from('inventory_writeoffs')
    .select('id, reason, created_at, items:inventory_writeoff_items(cost_kopecks)')
    .gte('created_at', from)
    .order('created_at', { ascending: false })

  if (error) throw new AppError('DB_ERROR', error.message, 500)

  const list = data ?? []
  const totalCost = list.reduce((s, w) => {
    const items = (w.items ?? []) as Array<{ cost_kopecks: number }>
    return s + items.reduce((si, i) => si + i.cost_kopecks, 0)
  }, 0)

  return { count: list.length, total_cost: totalCost, writeoffs: list }
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
    .select('id, sale_number, total, payment_method, status, completed_at, is_fiscal, cash_amount, card_amount')
    .eq('shift_id', shiftId)
    .order('completed_at', { ascending: true })

  const list = sales ?? []
  const completed = list.filter((s) => s.status === 'completed')

  // Касові операції для розподілу по співробітниках
  const { data: cashOps } = await db
    .from('cash_operations')
    .select('type, amount, created_by')
    .eq('shift_id', shiftId)

  // Розбивка: фіскальні / нефіскальні по кожному методу
  function filterSales(method: string) { return completed.filter((s) => s.payment_method === method) }

  // Готівка: cash_amount з усіх чеків (включаючи mixed)
  const cashTotal = completed.reduce((s: number, x: any) => s + ((x as any).cash_amount ?? 0), 0)
  const cashFiscal = completed
    .filter((s: any) => (s as any).is_fiscal && ((s as any).cash_amount ?? 0) > 0)
    .reduce((s: number, x: any) => s + ((x as any).cash_amount ?? 0), 0)

  // Термінал: card_amount з усіх чеків (включаючи mixed)
  const cardTotal = completed.reduce((s: number, x: any) => s + ((x as any).card_amount ?? 0), 0)
  const cardFiscal = completed
    .filter((s: any) => (s as any).is_fiscal && ((s as any).card_amount ?? 0) > 0)
    .reduce((s: number, x: any) => s + ((x as any).card_amount ?? 0), 0)

  const transferTotal = filterSales('transfer').reduce((s: number, x: any) => s + x.total, 0)

  return {
    shift,
    total_sales:   completed.length,
    total_revenue: completed.reduce((s: number, x: any) => s + x.total, 0),
    by_method: {
      cash:     cashTotal,
      card:     cardTotal,
      transfer: transferTotal,
      debt:     filterSales('debt').reduce((s: number, x: any) => s + x.total, 0),
    },
    fiscal_breakdown: {
      cash_fiscal:    cashFiscal,
      cash_non_fiscal: cashTotal - cashFiscal,
      card_fiscal:    cardFiscal,
      card_non_fiscal: cardTotal - cardFiscal,
      transfer_non_fiscal: transferTotal,
    },
    // Розподіл операцій по співробітниках
    by_user: (() => {
      const ops = cashOps ?? []
      const map: Record<string, { user_id: string; cash_in: number; cash_out: number; count: number }> = {}
      for (const op of ops) {
        if (!map[op.created_by]) {
          map[op.created_by] = { user_id: op.created_by, cash_in: 0, cash_out: 0, count: 0 }
        }
        if (op.type === 'in') map[op.created_by].cash_in += op.amount
        else map[op.created_by].cash_out += op.amount
        map[op.created_by].count++
      }
      return Object.values(map)
    })(),
    sales: list,
  }
}
