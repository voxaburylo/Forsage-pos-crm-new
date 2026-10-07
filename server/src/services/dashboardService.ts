import { z } from 'zod'
import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { kyivDateKey, kyivDateRange } from '../lib/businessDate.js'

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + 'T00:00:00.000Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    && Number(value.slice(0, 4)) >= 1000 && Number(value.slice(0, 4)) < 9999
}, 'Невірна календарна дата')

interface DayRow {
  date: string
  revenue: number
  cogs: number
  receipts: number
  gross_revenue: number
  refund_total: number
}
interface Snapshot {
  daily: DayRow[]
  expenses: number
  invalid_return_items: number
  overview: Record<string, number>
}

// One statement means all sections see the same committed database snapshot.
// Product-card prices must never replace the price recorded in a receipt.
const dashboardSql = `
  WITH selected_sales AS (
    SELECT id, tenant_id, total, COALESCE(completed_at, created_at) occurred_at
    FROM sales WHERE tenant_id=$1 AND status IN ('completed','returned')
      AND COALESCE(completed_at, created_at) >= $2::timestamptz
      AND COALESCE(completed_at, created_at) < $3::timestamptz
  ), sale_costs AS (
    SELECT si.sale_id, SUM(si.qty * COALESCE(si.cost_price, 0)) cogs
    FROM sale_items si
    JOIN selected_sales s ON s.id=si.sale_id AND s.tenant_id=si.tenant_id
    WHERE si.tenant_id=$1 GROUP BY si.sale_id
  ), selected_returns AS (
    SELECT id, tenant_id, sale_id, created_at, stock_action,
      COALESCE(refund_kopecks, refund_amount, 0) refund_total
    FROM returns WHERE tenant_id=$1 AND status='completed'
      AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
  ), return_costs AS (
    SELECT r.id,
      COALESCE(SUM(CASE WHEN r.stock_action='return_to_stock'
        THEN ri.quantity * COALESCE(si.cost_price, 0) ELSE 0 END), 0) cogs,
      COUNT(ri.id) FILTER (WHERE si.id IS NULL) invalid_items
    FROM selected_returns r
    LEFT JOIN return_items ri ON ri.return_id=r.id AND ri.tenant_id=r.tenant_id
    LEFT JOIN sale_items si ON si.id=ri.sale_item_id AND si.tenant_id=r.tenant_id AND si.sale_id=r.sale_id
    GROUP BY r.id
  ), movements AS (
    SELECT s.occurred_at, s.total revenue, COALESCE(c.cogs,0) cogs,
      1 receipts, s.total gross_revenue, 0 refund_total
    FROM selected_sales s LEFT JOIN sale_costs c ON c.sale_id=s.id
    UNION ALL
    SELECT r.created_at, -r.refund_total, -c.cogs, 0, 0, r.refund_total
    FROM selected_returns r JOIN return_costs c ON c.id=r.id
  ), daily AS (
    SELECT (occurred_at AT TIME ZONE 'Europe/Kyiv')::date::text date,
      SUM(revenue)::double precision revenue, SUM(cogs)::double precision cogs,
      SUM(receipts)::integer receipts, SUM(gross_revenue)::double precision gross_revenue,
      SUM(refund_total)::double precision refund_total
    FROM movements GROUP BY (occurred_at AT TIME ZONE 'Europe/Kyiv')::date
  ), overview AS (
    SELECT
      (SELECT COUNT(*) FROM products WHERE tenant_id=$1 AND deleted_at IS NULL AND is_active) products,
      (SELECT COUNT(*) FROM products WHERE tenant_id=$1 AND deleted_at IS NULL AND is_active
        AND qty_on_hand <= reorder_point) low_stock,
      (SELECT COALESCE(SUM(GREATEST(qty_on_hand,0)*COALESCE(purchase_price,0)),0)
        FROM products WHERE tenant_id=$1 AND deleted_at IS NULL AND is_active) stock_purchase_value,
      (SELECT COALESCE(SUM(GREATEST(qty_on_hand,0)*COALESCE(retail_price,0)),0)
        FROM products WHERE tenant_id=$1 AND deleted_at IS NULL AND is_active) stock_retail_value,
      (SELECT COUNT(*) FROM customers WHERE tenant_id=$1 AND deleted_at IS NULL) customers,
      (SELECT COUNT(*) FROM suppliers WHERE tenant_id=$1 AND deleted_at IS NULL) suppliers,
      (SELECT COUNT(*) FROM customer_orders WHERE tenant_id=$1 AND deleted_at IS NULL
        AND status NOT IN ('completed','canceled','cancelled','archived')) open_orders,
      (SELECT COUNT(*) FROM customer_orders WHERE tenant_id=$1 AND deleted_at IS NULL
        AND status NOT IN ('completed','canceled','cancelled','archived')
        AND pickup_deadline_at IS NOT NULL AND pickup_deadline_at < NOW()) overdue_orders,
      (SELECT COUNT(*) FROM customers WHERE tenant_id=$1 AND deleted_at IS NULL AND debt_balance>0) debt_customers,
      (SELECT COALESCE(SUM(debt_balance),0) FROM customers
        WHERE tenant_id=$1 AND deleted_at IS NULL AND debt_balance>0) debt_total
  )
  SELECT
    COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.date) FROM daily d),'[]'::jsonb) daily,
    (SELECT to_jsonb(o) FROM overview o) overview,
    (SELECT COALESCE(SUM(invalid_items),0)::integer FROM return_costs) invalid_return_items,
    (SELECT COALESCE(SUM(amount),0)::double precision FROM cash_operations
      WHERE tenant_id=$1 AND type='out' AND expense_category_id IS NOT NULL
        AND created_at >= $2::timestamptz AND created_at < $3::timestamptz) expenses
`

export async function getDashboard(query: unknown, tenantId: string, role: string) {
  const today = kyivDateKey()
  const parsed = z.object({
    startDate: calendarDate.default(today.slice(0, 8) + '01'),
    endDate: calendarDate.default(today),
  }).refine(range => range.startDate <= range.endDate, 'Початок періоду пізніше завершення').safeParse(query)
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірна дата або період', 400)
  const { startDate, endDate } = parsed.data
  const { from, toExclusive } = kyivDateRange(startDate, endDate)
  const { rows } = await pool.query<Snapshot>(dashboardSql, [tenantId, from, toExclusive])
  const snapshot = rows[0]
  if (!snapshot || !Array.isArray(snapshot.daily) || !snapshot.overview) {
    throw new AppError('INCOMPLETE_REPORT', 'Не вдалося отримати повну статистику', 503)
  }
  if (Number(snapshot.invalid_return_items) > 0) {
    throw new AppError('INCOMPLETE_REPORT', 'У поверненні немає зв’язку з початковим чеком. Статистику не розраховано.', 409)
  }
  const canSeeProfit = ['owner', 'admin'].includes(role)
  const sum = (field: keyof Omit<DayRow, 'date'>) => snapshot.daily.reduce((total, day) => total + Number(day[field]), 0)
  const totalRevenue = sum('revenue'), cogs = sum('cogs'), receipts = sum('receipts')
  const grossProfit = totalRevenue - cogs
  const expenses = Number(snapshot.expenses)
  const byDay = new Map(snapshot.daily.map(day => [day.date, day]))
  const daily: Array<{ date: string; revenue: number; profit: number }> = []
  const end = Date.parse(endDate + 'T00:00:00Z')
  for (let at = Date.parse(startDate + 'T00:00:00Z'); at <= end; at += 86400000) {
    const date = new Date(at).toISOString().slice(0, 10)
    const row = byDay.get(date)
    daily.push({ date, revenue: Number(row?.revenue ?? 0),
      profit: canSeeProfit && row ? Number(row.revenue) - Number(row.cogs) : 0 })
  }
  const o = snapshot.overview
  return {
    gross_revenue: sum('gross_revenue'), refund_total: sum('refund_total'),
    total_revenue: totalRevenue, cogs: canSeeProfit ? cogs : 0,
    gross_profit: canSeeProfit ? grossProfit : 0, total_expenses: canSeeProfit ? expenses : 0,
    net_profit: canSeeProfit ? grossProfit - expenses : 0,
    total_receipts: receipts, average_receipt: receipts ? Math.round(totalRevenue / receipts) : 0,
    daily, low_stock: Number(o.low_stock ?? 0),
    totals: { products: Number(o.products ?? 0), customers: Number(o.customers ?? 0),
      suppliers: Number(o.suppliers ?? 0), openOrders: Number(o.open_orders ?? 0) },
    overdue_count: Number(o.overdue_orders ?? 0),
    debt: { count: Number(o.debt_customers ?? 0), total: Number(o.debt_total ?? 0) },
    inventory: { purchase_value: Number(o.stock_purchase_value ?? 0), retail_value: Number(o.stock_retail_value ?? 0) },
  }
}
