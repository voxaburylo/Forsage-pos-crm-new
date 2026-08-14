import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import type { PeriodQuery } from '../validators/reportSchema.js'
import {
  summarizePaymentReceipts,
  type OrderPaymentReceipt,
  type SaleReceipt,
} from './cashAccounting.js'
import { kyivDateKey, kyivDateRange } from '../lib/businessDate.js'

function inclusiveKyivRange(fromDate: string, toDate: string): { from: string; to: string } {
  const { from, toExclusive } = kyivDateRange(fromDate, toDate)
  return { from, to: new Date(Date.parse(toExclusive) - 1).toISOString() }
}

function todayRange(): { from: string; to: string } {
  const today = kyivDateKey()
  return inclusiveKyivRange(today, today)
}

type SummarySale = SaleReceipt & {
  sale_number?: string
  status?: string
  completed_at?: string
  is_fiscal?: boolean | null
}

const ORDER_SALE_ID_CHUNK_SIZE = 200

async function loadOrderSaleIds(tenantId: string, saleIds: string[]): Promise<Set<string>> {
  const result = new Set<string>()
  for (let offset = 0; offset < saleIds.length; offset += ORDER_SALE_ID_CHUNK_SIZE) {
    const chunk = saleIds.slice(offset, offset + ORDER_SALE_ID_CHUNK_SIZE)
    const { data, error } = await db
      .from('customer_orders')
      .select('sale_id')
      .eq('tenant_id', tenantId)
      .in('sale_id', chunk)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    for (const row of data ?? []) {
      if (row.sale_id) result.add(row.sale_id)
    }
  }
  return result
}

function buildSummary(
  sales: SummarySale[],
  orderSaleIds: ReadonlySet<string>,
  orderPayments: OrderPaymentReceipt[],
) {
  const received = summarizePaymentReceipts(sales, orderSaleIds, orderPayments)
  return {
    total_sales: sales.length,
    total_revenue: sales.reduce((sum, sale) => sum + Number(sale.total ?? 0), 0),
    payment_received_total: received.total,
    by_method: {
      cash: received.cash,
      card: received.card,
      transfer: received.transfer,
      account: received.account,
      debt: received.debt,
    },
  }
}

async function buildSummaryForRange(
  sales: SummarySale[],
  tenantId: string,
  from: string,
  to: string,
) {
  const [orderSaleIds, paymentsResult] = await Promise.all([
    loadOrderSaleIds(tenantId, sales.map((sale) => sale.id)),
    db
      .from('order_payments')
      .select('amount,method,is_fiscal')
      .eq('tenant_id', tenantId)
      .gte('created_at', from)
      .lte('created_at', to),
  ])
  if (paymentsResult.error) throw new AppError('DB_ERROR', paymentsResult.error.message, 500)
  return buildSummary(sales, orderSaleIds, paymentsResult.data ?? [])
}

export async function getSalesToday(tenantId: string) {
  const { from, to } = todayRange()

  const { data, error } = await db
    .from('sales')
    .select('id, total, payment_method, cash_amount, card_amount, transfer_amount, debt_amount')
    .eq('tenant_id', tenantId)
    .gte('completed_at', from)
    .lte('completed_at', to)
    .in('status', ['completed', 'returned'])

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return buildSummaryForRange(data ?? [], tenantId, from, to)
}

export async function getSalesPeriod(query: PeriodQuery, tenantId: string) {
  const today = kyivDateKey()
  const startDate = query.from ?? today
  const endDate = query.to ?? query.from ?? today
  const { from: dateFrom, to: dateTo } = inclusiveKyivRange(startDate, endDate)

  // 1. Отримуємо продажі за період
  const { data: sales, error: salesErr } = await db
    .from('sales')
    .select('id, sale_number, total, payment_method, status, completed_at, cash_amount, card_amount, transfer_amount, debt_amount, customer:customers(id,phone,full_name)')
    .eq('tenant_id', tenantId)
    .gte('completed_at', dateFrom)
    .lte('completed_at', dateTo)
    .in('status', ['completed', 'returned'])
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
      .eq('tenant_id', tenantId)
      .in('sale_id', saleIds)

    if (itemsErr) throw new AppError('DB_ERROR', itemsErr.message, 500)

    for (const item of items ?? []) {
      const product = item.product as unknown as { purchase_price: number } | undefined
      const purchasePrice = product?.purchase_price ?? 0
      profit += (item.unit_price - purchasePrice) * item.qty
    }
  }

  return { ...await buildSummaryForRange(list, tenantId, dateFrom, dateTo), profit, sales: list }
}

export async function getLowStockProducts(tenantId: string) {
  // PostgREST не вміє порівнювати дві колонки → фільтруємо в JS
  const { data, error } = await db
    .from('products')
    .select('id, sku, name, qty_on_hand, reorder_point, unit, brand:brands(name), category:categories(name)')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .eq('is_active', true)

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return (data ?? [])
    .filter((p) => p.qty_on_hand <= p.reorder_point)
    .sort((a, b) => a.qty_on_hand - b.qty_on_hand)
}

export async function getDebtors(tenantId: string) {
  const { data, error } = await db
    .from('customers')
    .select('id, phone, full_name, debt_balance')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .gt('debt_balance', 0)
    .order('debt_balance', { ascending: false })

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data ?? []
}

export async function getWeeklySales(tenantId: string) {
  // Один запит замість 7 — групуємо в JS
  const today = kyivDateKey()
  const weekAgo = new Date(`${today}T12:00:00.000Z`)
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 6)
  const startDate = weekAgo.toISOString().slice(0, 10)
  const { from: fromDate, to } = inclusiveKyivRange(startDate, today)

  const { data, error } = await db
    .from('sales')
    .select('completed_at, total')
    .eq('tenant_id', tenantId)
    .gte('completed_at', fromDate)
    .lte('completed_at', to)
    .in('status', ['completed', 'returned'])
    .order('completed_at', { ascending: true })

  if (error) throw new AppError('DB_ERROR', error.message, 500)

  // Групуємо по днях
  const daysMap = new Map<string, { date: string; revenue: number; sales: number }>()
  for (const s of data ?? []) {
    const date = kyivDateKey(new Date(s.completed_at))
    const existing = daysMap.get(date) ?? { date, revenue: 0, sales: 0 }
    existing.revenue += s.total
    existing.sales++
    daysMap.set(date, existing)
  }

  // Заповнюємо 7 днів (включно з днями без продажів)
  const result: Array<{ date: string; revenue: number; sales: number }> = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(`${today}T12:00:00.000Z`)
    d.setUTCDate(d.getUTCDate() - i)
    const date = d.toISOString().slice(0, 10)
    result.push(daysMap.get(date) ?? { date, revenue: 0, sales: 0 })
  }

  return result
}

export async function getTopProducts(query: PeriodQuery, tenantId: string) {
  const today = kyivDateKey()
  const startDate = query.from ?? '1970-01-01'
  const endDate = query.to ?? today
  const { from: dateFrom, to: dateTo } = inclusiveKyivRange(startDate, endDate)

  // 1. Отримуємо ID продажів за період
  const { data: sales, error: salesErr } = await db
    .from('sales')
    .select('id')
    .eq('tenant_id', tenantId)
    .gte('completed_at', dateFrom)
    .lte('completed_at', dateTo)
    .in('status', ['completed', 'returned'])

  if (salesErr) throw new AppError('DB_ERROR', salesErr.message, 500)

  const saleIds = (sales ?? []).map((s) => s.id)
  if (saleIds.length === 0) return []

  // 2. Отримуємо всі sale_items з продуктами
  const { data: items, error: itemsErr } = await db
    .from('sale_items')
    .select('product_id, qty, unit_price, total, product:products!inner(sku, name)')
    .eq('tenant_id', tenantId)
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

export async function getWriteoffsSummary(tenantId: string) {
  const now = new Date()
  const year  = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const from  = year + '-' + month + '-01T00:00:00.000Z'

  const { data, error } = await db
    .from('inventory_writeoffs')
    .select('id, reason, created_at, items:inventory_writeoff_items(cost_kopecks)')
    .eq('tenant_id', tenantId)
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

export async function getShiftReport(shiftId: string, tenantId: string) {
  const { data: shift, error: shiftError } = await db
    .from('shifts')
    .select('*')
    .eq('id', shiftId)
    .eq('tenant_id', tenantId)
    .single()

  if (shiftError || !shift) throw new AppError('SHIFT_NOT_FOUND', 'Зміну не знайдено', 404)

  const [
    { data: sales, error: salesError },
    { data: cashOps, error: cashOpsError },
    { data: orderPayments, error: paymentError },
  ] = await Promise.all([
    db
      .from('sales')
      .select('id, sale_number, total, payment_method, status, completed_at, is_fiscal, cash_amount, card_amount')
      .eq('shift_id', shiftId)
      .eq('tenant_id', tenantId)
      .order('completed_at', { ascending: true }),
    db
      .from('cash_operations')
      .select('type, amount, created_by')
      .eq('shift_id', shiftId)
      .eq('tenant_id', tenantId),
    db
      .from('order_payments')
      .select('amount, method, is_fiscal')
      .eq('shift_id', shiftId)
      .eq('tenant_id', tenantId),
  ])
  if (salesError) throw new AppError('DB_ERROR', salesError.message, 500)
  if (cashOpsError) throw new AppError('DB_ERROR', cashOpsError.message, 500)
  if (paymentError) throw new AppError('DB_ERROR', paymentError.message, 500)

  const list = sales ?? []
  const completed = list.filter((sale) => sale.status === 'completed')
  const orderSaleIds = await loadOrderSaleIds(tenantId, completed.map((sale) => sale.id))
  const payments = orderPayments ?? []
  const received = summarizePaymentReceipts(completed, orderSaleIds, payments)
  const regularFiscalSales = completed.filter((sale) => !orderSaleIds.has(sale.id) && sale.is_fiscal)
  const fiscalReceived = summarizePaymentReceipts(
    regularFiscalSales,
    new Set(),
    payments.filter((payment) => payment.is_fiscal),
  )

  return {
    shift,
    total_sales: completed.length,
    total_revenue: completed.reduce((sum, sale) => sum + Number(sale.total ?? 0), 0),
    payment_received_total: received.total,
    by_method: {
      cash: received.cash,
      card: received.card,
      transfer: received.transfer,
      account: received.account,
      debt: received.debt,
    },
    fiscal_breakdown: {
      cash_fiscal: fiscalReceived.cash,
      cash_non_fiscal: received.cash - fiscalReceived.cash,
      card_fiscal: fiscalReceived.card,
      card_non_fiscal: received.card - fiscalReceived.card,
      transfer_fiscal: fiscalReceived.transfer,
      transfer_non_fiscal: received.transfer - fiscalReceived.transfer,
      account_non_fiscal: received.account,
    },
    // Оборот показуємо за датою видачі, а способи оплати — за зміною прийняття грошей.
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

// Продані товари за період — для дозамовлення у постачальників.
// Агрегує однакові позиції завершених чеків; послуги пропускаються.
export async function getSoldItems(fromDate: string, toDate: string, tenantId: string) {
  const { from, toExclusive } = kyivDateRange(fromDate, toDate)
  const sales: Array<{ id: string }> = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const { data: page, error } = await db.from('sales').select('id')
      .eq('tenant_id', tenantId).in('status', ['completed', 'returned'])
      .gte('completed_at', from).lt('completed_at', toExclusive)
      .order('completed_at', { ascending: true })
      .range(offset, offset + pageSize - 1)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    sales.push(...(page ?? []))
    if ((page?.length ?? 0) < pageSize) break
  }

  const ids = sales.map((sale) => sale.id)
  const agg = new Map<string, any>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data: items, error: itemsErr } = await db.from('sale_items')
      .select('product_id, qty, unit_price, discount, product:products(sku, barcode, name, unit, qty_on_hand, storage_bin, is_service)')
      .eq('tenant_id', tenantId)
      .in('sale_id', ids.slice(i, i + 100))
    if (itemsErr) throw new AppError('DB_ERROR', itemsErr.message, 500)
    for (const it of (items ?? []) as any[]) {
      if (!it.product_id || it.product?.is_service) continue
      const cur = agg.get(it.product_id) ?? {
        product_id: it.product_id,
        sku: it.product?.sku ?? '',
        barcode: it.product?.barcode ?? null,
        name: it.product?.name ?? '(товар видалено)',
        unit: it.product?.unit ?? 'шт',
        qty_on_hand: Number(it.product?.qty_on_hand ?? 0),
        storage_bin: it.product?.storage_bin ?? null,
        qty_sold: 0,
        qty_returned: 0,
        qty_net: 0,
        revenue: 0,
        refund_total: 0,
        net_revenue: 0,
      }
      const lineRevenue = it.unit_price * Number(it.qty) - (it.discount ?? 0)
      cur.qty_sold += Number(it.qty)
      cur.qty_net += Number(it.qty)
      cur.revenue += lineRevenue
      cur.net_revenue += lineRevenue
      agg.set(it.product_id, cur)
    }
  }
  const returnIds: string[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const { data: returns, error: returnsErr } = await db.from('returns')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('status', 'completed')
      .in('sale_id', ids.slice(i, i + 100))
    if (returnsErr) throw new AppError('DB_ERROR', returnsErr.message, 500)
    returnIds.push(...(returns ?? []).map((item) => item.id))
  }
  for (let i = 0; i < returnIds.length; i += 100) {
    const { data: items, error: returnItemsErr } = await db.from('return_items')
      .select('product_id, quantity, total_kopecks')
      .eq('tenant_id', tenantId)
      .in('return_id', returnIds.slice(i, i + 100))
    if (returnItemsErr) throw new AppError('DB_ERROR', returnItemsErr.message, 500)
    for (const item of items ?? []) {
      const current = agg.get(item.product_id)
      if (!current) continue
      current.qty_returned += Number(item.quantity ?? 0)
      current.refund_total += Number(item.total_kopecks ?? 0)
      current.qty_net = Math.max(0, current.qty_sold - current.qty_returned)
      current.net_revenue = Math.max(0, current.revenue - current.refund_total)
    }
  }
  return [...agg.values()].sort((a, b) => b.qty_net - a.qty_net)
}
