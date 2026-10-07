import { z } from 'zod'
import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { kyivDateKey, kyivDateRange } from '../lib/businessDate.js'
import { allocateReceiptRevenue } from '../lib/receiptRevenue.js'

const money = z.number().int().safe()
const nonnegative = money.nonnegative()
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + 'T00:00:00Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    && Number(value.slice(0, 4)) >= 1000 && Number(value.slice(0, 4)) < 9999
})
const identity = { employee_id: z.string().nullable(), order_id: z.string().nullable(),
  order_count: z.number().int().min(0).max(1) }
const snapshotSchema = z.object({
  staff: z.array(z.object({ id: z.string(), name: z.string().nullable(), role: z.string().nullable() })),
  sales: z.array(z.object({
    id: z.string(), total: nonnegative, ...identity,
    items: z.array(z.object({ id: z.string(), qty: z.number().finite().positive(),
      total: nonnegative, cost_price: nonnegative, unit_price: nonnegative, coreTotal: nonnegative })).min(1),
  })),
  returns: z.array(z.object({
    id: z.string(), amount: nonnegative, ...identity, source_sale_id: z.string(),
    stock_action: z.enum(['return_to_stock', 'write_off', 'send_to_supplier']),
    items: z.array(z.object({ id: z.string(), quantity: z.number().finite().positive(),
      total_kopecks: nonnegative, cost_price: nonnegative, source_id: z.string(),
      product_id: z.string().nullable(), source_product_id: z.string().nullable() })).min(1),
  })),
  salary: z.array(z.object({ employee_id: z.string(), employee_name: z.string(),
    type: z.enum(['salary', 'bonus', 'advance', 'penalty']), amount: money,
    source: z.string() }).refine(row => row.amount >= 0 || (row.type === 'bonus' && row.source === 'commission_reversal'))),
})

// One read-only statement: no PostgREST row cap, N+1 auth calls, or mixed snapshots.
// An order classifies its settled receipt; it never adds a second revenue stream.
const staffSql = `
  WITH selected_sales AS (
    SELECT s.id,s.tenant_id,s.total,s.manager_id,s.cashier_id FROM sales s
    WHERE s.tenant_id=$1 AND s.status IN ('completed','returned')
      AND COALESCE(s.completed_at,s.created_at)>=$2::timestamptz
      AND COALESCE(s.completed_at,s.created_at)<$3::timestamptz
  ), selected_returns AS (
    SELECT r.id,r.tenant_id,r.sale_id,r.stock_action,COALESCE(r.refund_kopecks,r.refund_amount) amount
    FROM returns r WHERE r.tenant_id=$1 AND r.status='completed'
      AND r.created_at>=$2::timestamptz AND r.created_at<$3::timestamptz
  ), relevant_sales AS (
    SELECT id FROM selected_sales UNION SELECT sale_id FROM selected_returns
  ), order_links AS (
    SELECT o.sale_id,COUNT(*)::integer order_count,
      MIN(o.id::text) order_id,MIN(o.manager_id::text) manager_id
    FROM customer_orders o JOIN relevant_sales s ON s.id=o.sale_id
    WHERE o.tenant_id=$1 GROUP BY o.sale_id
  ), sale_lines AS (
    SELECT si.sale_id,jsonb_agg(jsonb_build_object(
      'id',si.id,'qty',si.qty,'total',si.total,'cost_price',si.cost_price,
      'unit_price',si.unit_price,'coreTotal',ROUND(si.qty*COALESCE(si.core_deposit_amount,0))
    ) ORDER BY si.id) items FROM sale_items si
    JOIN selected_sales s ON s.id=si.sale_id AND s.tenant_id=si.tenant_id
    WHERE si.tenant_id=$1 GROUP BY si.sale_id
  ), return_lines AS (
    SELECT r.id return_id,jsonb_agg(jsonb_build_object(
      'id',ri.id,'quantity',ri.quantity,'total_kopecks',ri.total_kopecks,'cost_price',si.cost_price,
      'source_id',si.id,'product_id',ri.product_id,'source_product_id',si.product_id
    ) ORDER BY ri.id) items FROM selected_returns r
    JOIN return_items ri ON ri.return_id=r.id AND ri.tenant_id=r.tenant_id
    LEFT JOIN sale_items si ON si.id=ri.sale_item_id AND si.tenant_id=r.tenant_id AND si.sale_id=r.sale_id
    GROUP BY r.id
  )
  SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',raw_user_meta_data->>'full_name','role',raw_app_meta_data->>'role'))
      FROM auth.users WHERE raw_app_meta_data->>'tenant_id'=$1::text),'[]'::jsonb) staff,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',s.id,'total',s.total,'employee_id',COALESCE(s.manager_id::text,o.manager_id,s.cashier_id::text),
      'order_id',o.order_id,'order_count',COALESCE(o.order_count,0),'items',COALESCE(l.items,'[]'::jsonb)
    )) FROM selected_sales s LEFT JOIN sale_lines l ON l.sale_id=s.id
      LEFT JOIN order_links o ON o.sale_id=s.id),'[]'::jsonb) sales,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',r.id,'amount',r.amount,'stock_action',r.stock_action,'source_sale_id',s.id,
      'employee_id',COALESCE(s.manager_id::text,o.manager_id,s.cashier_id::text),
      'order_id',o.order_id,'order_count',COALESCE(o.order_count,0),'items',COALESCE(l.items,'[]'::jsonb)
    )) FROM selected_returns r LEFT JOIN return_lines l ON l.return_id=r.id
      LEFT JOIN sales s ON s.id=r.sale_id AND s.tenant_id=r.tenant_id AND s.status IN ('completed','returned')
      LEFT JOIN order_links o ON o.sale_id=s.id),'[]'::jsonb) returns,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'employee_id',employee_id,'employee_name',employee_name,'type',type,'amount',amount,'source',source
    )) FROM salary_payments WHERE tenant_id=$1 AND work_date>=$4::date AND work_date<=$5::date),'[]'::jsonb) salary
`

function incomplete(): never {
  throw new AppError('INCOMPLETE_REPORT', 'Звіт працівників містить неповні або неузгоджені дані. Оновіть резервну копію та перевірте чеки.', 503)
}

export async function getStaffAnalytics(query: unknown, tenantId: string, kind: 'profitability' | 'kpi') {
  const today = kyivDateKey()
  const parsed = z.object({ startDate: calendarDate.default(today.slice(0, 7) + '-01'),
    endDate: calendarDate.default(today) }).refine(q => q.startDate <= q.endDate).safeParse(query)
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірний період звіту працівників', 400)
  const { startDate, endDate } = parsed.data
  const { from, toExclusive } = kyivDateRange(startDate, endDate)
  const result = await pool.query(staffSql, [tenantId, from, toExclusive, startDate, endDate])
  const checked = snapshotSchema.safeParse(result.rows[0])
  if (!checked.success) incomplete()
  const snapshot = checked.data
  const names = new Map(snapshot.staff.map(row => [row.id, row.name?.trim() || 'Працівник без імені']))
  for (const payment of snapshot.salary) {
    if (!names.has(payment.employee_id) && payment.employee_name.trim()) names.set(payment.employee_id, payment.employee_name.trim())
  }
  const makeRow = (id: string, name?: string) => ({
    manager_id: id, manager_name: names.get(id) || name?.trim() || 'Невідомий працівник',
    sales_revenue: 0, sales_cogs: 0, orders_revenue: 0, orders_cogs: 0,
    salary_cost: 0, bonus_cost: 0, advance_cost: 0, penalty_cost: 0,
    gross_revenue: 0, receipt_count: 0, total_discounts: 0, before_discount: 0,
    returns_count: 0, returns_amount: 0,
  })
  const rows = new Map<string, ReturnType<typeof makeRow>>()
  if (kind === 'profitability') for (const staff of snapshot.staff) rows.set(staff.id, makeRow(staff.id))
  const employee = (id: string | null, name?: string) => {
    const key = id || 'unknown'
    if (!rows.has(key)) rows.set(key, makeRow(key, name))
    return rows.get(key)!
  }
  for (const sale of snapshot.sales) {
    try { allocateReceiptRevenue(sale.total, sale.items) } catch { incomplete() }
    const row = employee(sale.employee_id)
    let beforeDiscount = 0
    for (const line of sale.items) {
      beforeDiscount += Math.round(line.qty * line.unit_price) + line.coreTotal
      row[sale.order_id ? 'orders_cogs' : 'sales_cogs'] += line.qty * line.cost_price
    }
    if (!Number.isSafeInteger(beforeDiscount) || beforeDiscount < sale.total) incomplete()
    row[sale.order_id ? 'orders_revenue' : 'sales_revenue'] += sale.total
    row.gross_revenue += sale.total
    row.receipt_count++
    row.before_discount += beforeDiscount
    row.total_discounts += beforeDiscount - sale.total
  }
  for (const refund of snapshot.returns) {
    if (refund.items.reduce((sum, line) => sum + line.total_kopecks, 0) !== refund.amount) incomplete()
    const row = employee(refund.employee_id)
    row[refund.order_id ? 'orders_revenue' : 'sales_revenue'] -= refund.amount
    row.returns_amount += refund.amount
    row.returns_count++
    for (const line of refund.items) {
      if (line.product_id !== line.source_product_id) incomplete()
      if (refund.stock_action === 'return_to_stock') {
        row[refund.order_id ? 'orders_cogs' : 'sales_cogs'] -= line.quantity * line.cost_price
      }
    }
  }
  if (kind === 'kpi') {
    const result = [...rows.values()].map(row => ({
      manager_id: row.manager_id, manager_name: row.manager_name,
      // KPI preserves the gross receipt metric; returns are shown separately.
      total_revenue: row.gross_revenue, receipt_count: row.receipt_count,
      average_receipt: row.receipt_count ? Math.round(row.gross_revenue / row.receipt_count) : 0,
      total_discounts: row.total_discounts,
      discount_pct: row.before_discount ? Math.round(100 * row.total_discounts / row.before_discount) : 0,
      returns_count: row.returns_count, returns_amount: row.returns_amount,
    })).sort((a, b) => b.total_revenue - a.total_revenue || a.manager_id.localeCompare(b.manager_id))
    if (result.some(row => Object.entries(row).some(([key, value]) => !key.startsWith('manager_') && !Number.isSafeInteger(value)))) incomplete()
    return result
  }

  // Preserve the existing payroll policy: owners have sales, not employee salary debt.
  const ownerIds = new Set(snapshot.staff.filter(person => person.role === 'owner').map(person => person.id))
  for (const payment of snapshot.salary) {
    if (ownerIds.has(payment.employee_id)) continue
    employee(payment.employee_id, payment.employee_name)[`${payment.type}_cost`] += payment.amount
  }
  return [...rows.values()].map(row => {
    const total_cogs = Math.round(row.sales_cogs + row.orders_cogs)
    const sales_cogs = Math.round(row.sales_cogs), orders_cogs = total_cogs - sales_cogs
    const total_revenue = row.sales_revenue + row.orders_revenue
    const gross_profit = total_revenue - total_cogs
    const result = { manager_id: row.manager_id, manager_name: row.manager_name,
      sales_revenue: row.sales_revenue, sales_cogs, orders_revenue: row.orders_revenue, orders_cogs,
      total_revenue, total_cogs, gross_profit, salary_cost: row.salary_cost, bonus_cost: row.bonus_cost,
      advance_cost: row.advance_cost, penalty_cost: row.penalty_cost, total_payouts: row.advance_cost,
      net_profit: gross_profit - row.salary_cost - row.bonus_cost + row.penalty_cost }
    if (Object.entries(result).some(([key, value]) => !key.startsWith('manager_') && !Number.isSafeInteger(value))) incomplete()
    return result
  }).sort((a, b) => b.net_profit - a.net_profit || a.manager_id.localeCompare(b.manager_id))
}
