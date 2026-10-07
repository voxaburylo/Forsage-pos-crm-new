export async function getSoldItems(from: string, to: string, tenantId: string) {
  const report = await import('./soldItemsReport.js')
  return report.getSoldItems(from,to,tenantId)
}
import { readReportPages } from '../lib/readReportPages.js'
import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import type { PeriodQuery } from '../validators/reportSchema.js'

import { kyivDateKey, kyivDateRange } from '../lib/businessDate.js'


function inclusiveKyivRange(fromDate: string, toDate: string): { from: string; to: string } {
  const { from, toExclusive } = kyivDateRange(fromDate, toDate)
  return { from, to: new Date(Date.parse(toExclusive) - 1).toISOString() }
}





export async function getSalesToday(tenantId: string) {
  const { sales: _sales, daily: _daily, ...summary } = await getSalesPeriod({},tenantId)
  return summary
}

export async function getSalesPeriod(query: PeriodQuery, tenantId: string) {
  const from = query.from ?? kyivDateKey(), to = query.to ?? from
  const { readPeriodReport } = await import('./periodReport.js')
  return readPeriodReport(from,to,tenantId)
}

export async function getLowStockProducts(tenantId: string) {
  // PostgREST не вміє порівнювати дві колонки → фільтруємо в JS
  const { data, error } = await readReportPages(db
    .from('products')
    .select('id, sku, name, qty_on_hand, reorder_point, unit, brand:brands(name), category:categories(name)')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .eq('is_active', true))

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return (data ?? [])
    .filter((p) => p.qty_on_hand <= p.reorder_point)
    .sort((a, b) => a.qty_on_hand - b.qty_on_hand)
}

export async function getDebtors(tenantId: string) {
  const { data, error } = await readReportPages(db
    .from('customers')
    .select('id, phone, full_name, debt_balance')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .gt('debt_balance', 0)
    .order('debt_balance', { ascending: false }))

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

export async function getWeeklySales(tenantId: string) {
  const today = kyivDateKey()
  const dates = Array.from({length:7},(_,index) => {
    const date = new Date(today+'T12:00:00Z'); date.setUTCDate(date.getUTCDate()-6+index)
    return date.toISOString().slice(0,10)
  })
  const report = await getSalesPeriod({from:dates[0],to:today},tenantId)
  return dates.map(date => report.daily.find(row=>row.date===date)
    ?? {date,revenue:0,gross_revenue:0,returns_total:0,sales:0})
}

export async function getTopProducts(query: PeriodQuery, tenantId: string) {
  const today = kyivDateKey()
  const startDate = query.from ?? '1970-01-01'
  const endDate = query.to ?? today
  const { from: dateFrom, to: dateTo } = inclusiveKyivRange(startDate, endDate)

  // 1. Отримуємо ID продажів за період
  const { data: sales, error: salesErr } = await readReportPages(db
    .from('sales')
    .select('id')
    .eq('tenant_id', tenantId)
    .gte('completed_at', dateFrom)
    .lte('completed_at', dateTo)
    .in('status', ['completed', 'returned']))

  if (salesErr) throw new AppError('DB_ERROR', salesErr.message, 500)

  const saleIds = (sales ?? []).map((s) => s.id)
  if (saleIds.length === 0) return []

  // 2. Отримуємо всі sale_items з продуктами
  const items: any[] = []
  for (let offset = 0; offset < saleIds.length; offset += 100) {
    const page = await readReportPages(db.from('sale_items')
      .select('product_id, qty, unit_price, total, product:products!inner(sku, name)')
      .eq('tenant_id', tenantId).in('sale_id', saleIds.slice(offset, offset + 100)))
    if (page.error) throw new AppError('DB_ERROR', page.error.message, 500)
    items.push(...page.data)
  }

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

export { readWriteoffSummary as getWriteoffsSummary } from './writeoffReport.js'

export async function getShiftReport(shiftId: string, tenantId: string) {
  const { readShiftReport } = await import('./shiftReport.js')
  return readShiftReport(shiftId,tenantId)
}
