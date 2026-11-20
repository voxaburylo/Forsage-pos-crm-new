import { z } from 'zod'
import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { kyivDateRange } from '../lib/businessDate.js'

/**
 * Звіт «Контроль» для власника: порівняння з попереднім періодом, продажі нижче закупки,
 * низька націнка, залежані товари. Лише читання копії, яку надіслала каса.
 * Закупка рядка — знімок cost_price на момент продажу; 0 означає «невідома», такі рядки не судимо.
 */
export const controlReportQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  margin_pct: z.coerce.number().min(0).max(100).default(10),
  stale_days: z.coerce.number().int().min(14).max(730).default(90),
  low_days: z.coerce.number().int().min(3).max(60).default(14),
})
export type ControlReportQuery = z.infer<typeof controlReportQuery>

const DAY = 86_400_000
const LINE_LIMIT = 300

export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const start = Date.parse(from + 'T00:00:00Z'), end = Date.parse(to + 'T00:00:00Z')
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new AppError('VALIDATION_ERROR', 'Некоректний період', 422)
  const days = Math.round((end - start) / DAY) + 1
  if (days > 400) throw new AppError('VALIDATION_ERROR', 'Період звіту — не більше 400 днів', 422)
  const iso = (time: number) => new Date(time).toISOString().slice(0, 10)
  return { from: iso(start - days * DAY), to: iso(start - DAY) }
}

export interface PeriodTotals { receipts: number; revenue: number; returns: number; discounts: number; profit: number; profit_known_revenue: number }

async function periodTotals(tenantId: string, from: string, to: string): Promise<PeriodTotals> {
  const range = kyivDateRange(from, to)
  const { rows } = await pool.query(
    `WITH s AS (
       SELECT id, total, discount FROM sales
        WHERE tenant_id = $1 AND status IN ('completed','returned') AND completed_at >= $2 AND completed_at < $3
     ), i AS (
       SELECT COALESCE(sum(si.discount),0) item_discount,
              COALESCE(sum(si.total - si.cost_price * si.qty) FILTER (WHERE si.cost_price > 0),0) profit,
              COALESCE(sum(si.total) FILTER (WHERE si.cost_price > 0),0) known
         FROM sale_items si JOIN s ON s.id = si.sale_id WHERE si.tenant_id = $1
     )
     SELECT (SELECT count(*) FROM s) receipts,
            (SELECT COALESCE(sum(total),0) FROM s) revenue,
            (SELECT COALESCE(sum(discount),0) FROM s) + (SELECT item_discount FROM i) discounts,
            (SELECT profit FROM i) profit, (SELECT known FROM i) known,
            (SELECT COALESCE(sum(refund_amount),0) FROM returns
               WHERE tenant_id = $1 AND status = 'completed' AND created_at >= $2 AND created_at < $3) returns`,
    [tenantId, range.from, range.toExclusive],
  )
  const row = rows[0] ?? {}
  const n = (value: unknown) => Math.round(Number(value) || 0)
  return { receipts: n(row.receipts), revenue: n(row.revenue), returns: n(row.returns), discounts: n(row.discounts), profit: n(row.profit), profit_known_revenue: n(row.known) }
}

export interface ControlLine {
  sale_number: string; completed_at: string; product_id: string; name: string; sku: string | null
  qty: number; total: number; cost: number; margin: number; margin_pct: number | null; employee: string | null
}

async function marginLines(tenantId: string, from: string, to: string, marginPct: number): Promise<{ below_cost: ControlLine[]; low_margin: ControlLine[] }> {
  const range = kyivDateRange(from, to)
  const { rows } = await pool.query(
    `SELECT s.sale_number, s.completed_at, si.product_id, p.name, p.sku, si.qty::float8 qty, si.total,
            round(si.cost_price * si.qty)::bigint cost,
            (SELECT u.raw_user_meta_data->>'full_name' FROM auth.users u WHERE u.id = COALESCE(s.manager_id, s.cashier_id)) employee
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id AND s.tenant_id = si.tenant_id
       JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
      WHERE si.tenant_id = $1 AND s.status IN ('completed','returned') AND s.completed_at >= $2 AND s.completed_at < $3
        AND si.cost_price > 0 AND si.qty > 0
        AND (si.total - si.cost_price * si.qty) < si.total * $4::numeric / 100
      ORDER BY (si.total - si.cost_price * si.qty) ASC, s.completed_at DESC
      LIMIT $5`,
    [tenantId, range.from, range.toExclusive, marginPct, LINE_LIMIT * 2],
  )
  const lines: ControlLine[] = rows.map((row: any) => {
    const total = Number(row.total) || 0, cost = Number(row.cost) || 0
    return {
      sale_number: String(row.sale_number), completed_at: new Date(row.completed_at).toISOString(),
      product_id: row.product_id, name: row.name, sku: row.sku ?? null, qty: Number(row.qty) || 0,
      total, cost, margin: total - cost, margin_pct: total > 0 ? Math.round(((total - cost) / total) * 1000) / 10 : null,
      employee: row.employee ?? null,
    }
  })
  return {
    below_cost: lines.filter(line => line.margin < 0).slice(0, LINE_LIMIT),
    low_margin: lines.filter(line => line.margin >= 0).slice(0, LINE_LIMIT),
  }
}

export interface StaleProduct { id: string; name: string; sku: string | null; qty_on_hand: number; stock_cost: number; last_sale_at: string | null; storage_bin: string | null }

async function staleProducts(tenantId: string, staleDays: number): Promise<StaleProduct[]> {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.sku, p.qty_on_hand::float8 qty, p.purchase_price, p.storage_bin, last.last_sale_at
       FROM products p
       LEFT JOIN LATERAL (
         SELECT max(s.completed_at) last_sale_at FROM sale_items si
           JOIN sales s ON s.id = si.sale_id AND s.tenant_id = si.tenant_id
          WHERE si.tenant_id = p.tenant_id AND si.product_id = p.id AND s.status IN ('completed','returned')
       ) last ON true
      WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.is_active AND NOT p.is_service AND p.qty_on_hand > 0
        AND (last.last_sale_at IS NULL OR last.last_sale_at < now() - make_interval(days => $2))
        AND p.created_at < now() - make_interval(days => $2)
      ORDER BY p.qty_on_hand * p.purchase_price DESC
      LIMIT $3`,
    [tenantId, staleDays, LINE_LIMIT],
  )
  return rows.map((row: any) => ({
    id: row.id, name: row.name, sku: row.sku ?? null, qty_on_hand: Number(row.qty) || 0,
    stock_cost: Math.round((Number(row.qty) || 0) * (Number(row.purchase_price) || 0)),
    last_sale_at: row.last_sale_at ? new Date(row.last_sale_at).toISOString() : null, storage_bin: row.storage_bin ?? null,
  }))
}

export interface StaffTotals {
  employee_id: string | null; employee: string | null; receipts: number; revenue: number; discounts: number
  profit: number; profit_known_revenue: number; average_receipt: number; below_cost_lines: number
}

/** Порівняння по працівниках за період: хто оформив чек (менеджер, інакше касир). */
async function staffTotals(tenantId: string, from: string, to: string): Promise<StaffTotals[]> {
  const range = kyivDateRange(from, to)
  const { rows } = await pool.query(
    `WITH s AS (
       SELECT id, total, discount, COALESCE(manager_id, cashier_id) emp FROM sales
        WHERE tenant_id = $1 AND status IN ('completed','returned') AND completed_at >= $2 AND completed_at < $3
     ), i AS (
       SELECT s.emp, COALESCE(sum(si.discount),0) item_discount,
              COALESCE(sum(si.total - si.cost_price * si.qty) FILTER (WHERE si.cost_price > 0),0) profit,
              COALESCE(sum(si.total) FILTER (WHERE si.cost_price > 0),0) known,
              count(*) FILTER (WHERE si.cost_price > 0 AND si.qty > 0 AND si.total < si.cost_price * si.qty) below_cost
         FROM sale_items si JOIN s ON s.id = si.sale_id WHERE si.tenant_id = $1 GROUP BY s.emp
     )
     SELECT s.emp, count(*) receipts, COALESCE(sum(s.total),0) revenue, COALESCE(sum(s.discount),0) sale_discount,
            max(i.item_discount) item_discount, max(i.profit) profit, max(i.known) known, max(i.below_cost) below_cost,
            (SELECT u.raw_user_meta_data->>'full_name' FROM auth.users u WHERE u.id = s.emp) employee
       FROM s LEFT JOIN i ON i.emp IS NOT DISTINCT FROM s.emp
      GROUP BY s.emp
      ORDER BY revenue DESC`,
    [tenantId, range.from, range.toExclusive],
  )
  const n = (value: unknown) => Math.round(Number(value) || 0)
  return rows.map((row: any) => {
    const receipts = n(row.receipts), revenue = n(row.revenue)
    return {
      employee_id: row.emp ?? null, employee: row.employee ?? null, receipts, revenue,
      discounts: n(row.sale_discount) + n(row.item_discount), profit: n(row.profit), profit_known_revenue: n(row.known),
      average_receipt: receipts ? Math.round(revenue / receipts) : 0, below_cost_lines: n(row.below_cost),
    }
  })
}

export const RUNNING_OUT_WINDOW_DAYS = 30
export interface RunningOutProduct {
  id: string; name: string; sku: string | null; storage_bin: string | null; qty_on_hand: number; reorder_point: number
  sold_30d: number; days_left: number | null; order_qty: number; order_cost: number
}

/**
 * «Закінчуються»: продаються, але залишку вистачить менше ніж на lowDays днів за темпом останніх 30 днів,
 * або залишок не вище точки дозамовлення. order_qty — скільки докупити, щоб вистачило на 30 днів.
 */
export function runningOutRows(rows: Array<{ id: string; name: string; sku: string | null; storage_bin: string | null; qty: number; reorder_point: number; sold: number; purchase_price: number }>, lowDays: number): RunningOutProduct[] {
  const result: RunningOutProduct[] = []
  for (const row of rows) {
    const qty = Math.max(0, Number(row.qty) || 0), sold = Math.max(0, Number(row.sold) || 0), reorder = Math.max(0, Number(row.reorder_point) || 0)
    const perDay = sold / RUNNING_OUT_WINDOW_DAYS
    const daysLeft = perDay > 0 ? Math.floor(qty / perDay) : null
    const belowReorder = reorder > 0 && qty <= reorder
    if (!belowReorder && (daysLeft === null || daysLeft >= lowDays)) continue
    const orderQty = Math.max(Math.ceil(perDay * RUNNING_OUT_WINDOW_DAYS - qty), reorder > 0 ? Math.ceil(reorder - qty) + 1 : 0, 1)
    result.push({
      id: row.id, name: row.name, sku: row.sku ?? null, storage_bin: row.storage_bin ?? null, qty_on_hand: qty, reorder_point: reorder,
      sold_30d: Math.round(sold * 1000) / 1000, days_left: daysLeft, order_qty: orderQty, order_cost: Math.round(orderQty * (Number(row.purchase_price) || 0)),
    })
  }
  return result.sort((a, b) => (a.days_left ?? -1) - (b.days_left ?? -1) || b.sold_30d - a.sold_30d).slice(0, LINE_LIMIT)
}

async function runningOut(tenantId: string, lowDays: number): Promise<RunningOutProduct[]> {
  const { rows } = await pool.query(
    `WITH sold AS (
       SELECT si.product_id, sum(si.qty) qty FROM sale_items si
         JOIN sales s ON s.id = si.sale_id AND s.tenant_id = si.tenant_id
        WHERE si.tenant_id = $1 AND s.status IN ('completed','returned') AND s.completed_at >= now() - make_interval(days => $2)
        GROUP BY si.product_id
     )
     SELECT p.id, p.name, p.sku, p.storage_bin, p.qty_on_hand::float8 qty, p.reorder_point::float8 reorder_point,
            COALESCE(sold.qty, 0)::float8 sold, p.purchase_price
       FROM products p LEFT JOIN sold ON sold.product_id = p.id
      WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.is_active AND NOT p.is_service
        AND (sold.qty > 0 OR (p.reorder_point > 0 AND p.qty_on_hand <= p.reorder_point))`,
    [tenantId, RUNNING_OUT_WINDOW_DAYS],
  )
  return runningOutRows(rows as any[], lowDays)
}

export async function buildControlReport(tenantId: string, query: ControlReportQuery) {
  const previous = previousPeriod(query.from, query.to)
  const [current, before, margins, stale, staff, staffBefore, low] = await Promise.all([
    periodTotals(tenantId, query.from, query.to),
    periodTotals(tenantId, previous.from, previous.to),
    marginLines(tenantId, query.from, query.to, query.margin_pct),
    staleProducts(tenantId, query.stale_days),
    staffTotals(tenantId, query.from, query.to),
    staffTotals(tenantId, previous.from, previous.to),
    runningOut(tenantId, query.low_days),
  ])
  return {
    period: { from: query.from, to: query.to }, previous_period: previous, current, previous: before, ...margins, stale,
    staff, staff_previous: staffBefore, running_out: low,
    margin_pct: query.margin_pct, stale_days: query.stale_days, low_days: query.low_days,
  }
}
