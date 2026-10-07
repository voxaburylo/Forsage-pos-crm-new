/**
 * Звіти каси: підсумок дня і продані позиції.
 *
 * Частина каси, винесена з `posRepository.ts` (3431 рядок) — див.
 * `REFACTOR_PLAN.md`, ітерація 4. Клас поділено ланцюжком успадкування:
 * кожен шар кличе лише те, що лежить нижче, тому жоден виклик `this.` не
 * довелося переписувати. Методи перенесені рядок у рядок.
 */
import { DEFAULT_TENANT_ID } from '../../db/localTypes'
import { businessDateKey, nowIso } from './posShared'
import { LocalPosFiscal } from './fiscal'
import { readSoldItems } from './soldItemsReport'
import { readPeriodReport } from './periodReport'

export class LocalPosReports extends LocalPosFiscal {
  salesPeriodReport(input: { tenant_id?: string; date_from: string; date_to: string }) {
    return readPeriodReport(this.db,input.tenant_id ?? DEFAULT_TENANT_ID,input.date_from,input.date_to)
  }
  dashboardSummary(input: { tenant_id?: string; date_from: string; date_to: string }): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const dateFrom = String(input.date_from ?? '').trim()
    const dateTo = String(input.date_to ?? '').trim()
    if (!dateFrom || !dateTo) throw new Error('Analytics period is required')

    const stats = this.db.prepare(`
      WITH scope(tenant_id, now_at) AS (VALUES (?, ?))
      SELECT
        (SELECT COUNT(*)
         FROM products p
         WHERE p.tenant_id = scope.tenant_id
           AND p.deleted_at IS NULL
           AND p.is_active = 1) AS products,
        (SELECT COUNT(*)
         FROM products p
         WHERE p.tenant_id = scope.tenant_id
           AND p.deleted_at IS NULL
           AND p.is_active = 1
           AND p.qty_on_hand <= p.reorder_point) AS low_stock,
        (SELECT COALESCE(SUM(MAX(p.qty_on_hand, 0) * COALESCE(p.purchase_price, 0)), 0)
         FROM products p
         WHERE p.tenant_id = scope.tenant_id
           AND p.deleted_at IS NULL
           AND p.is_active = 1) AS stock_purchase_value,
        (SELECT COALESCE(SUM(MAX(p.qty_on_hand, 0) * COALESCE(p.retail_price, 0)), 0)
         FROM products p
         WHERE p.tenant_id = scope.tenant_id
           AND p.deleted_at IS NULL
           AND p.is_active = 1) AS stock_retail_value,
        (SELECT COUNT(*)
         FROM customers c
         WHERE c.tenant_id = scope.tenant_id
           AND c.deleted_at IS NULL) AS customers,
        (SELECT COUNT(*)
         FROM suppliers s
         WHERE s.tenant_id = scope.tenant_id
           AND s.deleted_at IS NULL) AS suppliers,
        (SELECT COUNT(*)
         FROM customer_orders o
         WHERE o.tenant_id = scope.tenant_id
           AND o.deleted_at IS NULL
           AND o.status NOT IN ('completed', 'canceled', 'cancelled', 'archived')) AS open_orders,
        (SELECT COUNT(*)
         FROM customer_orders o
         WHERE o.tenant_id = scope.tenant_id
           AND o.deleted_at IS NULL
           AND o.status NOT IN ('completed', 'canceled', 'cancelled', 'archived')
           AND o.pickup_deadline_at IS NOT NULL
           AND o.pickup_deadline_at < scope.now_at) AS overdue_orders,
        (SELECT COUNT(*)
         FROM customers c
         WHERE c.tenant_id = scope.tenant_id
           AND c.deleted_at IS NULL
           AND c.debt_balance > 0) AS debt_customers,
        (SELECT COALESCE(SUM(c.debt_balance), 0)
         FROM customers c
         WHERE c.tenant_id = scope.tenant_id
           AND c.deleted_at IS NULL
           AND c.debt_balance > 0) AS debt_total
      FROM scope
    `).get(tenantId, nowIso()) as any

    const sales = this.db.prepare(`
      SELECT
        s.id,
        COALESCE(s.completed_at, s.created_at) AS occurred_at,
        COALESCE(s.total, 0) AS revenue,
        COALESCE(SUM(
          CASE WHEN si.deleted_at IS NULL
            THEN COALESCE(si.purchase_price, 0) * COALESCE(si.qty, 0)
            ELSE 0
          END
        ), 0) AS cogs,
        SUM(CASE WHEN si.deleted_at IS NULL AND si.id IS NOT NULL
          AND COALESCE(si.purchase_price, 0) = 0 AND COALESCE(p.is_service, 0) = 0
          THEN 1 ELSE 0 END) AS zero_cost_lines
      FROM sales s
      LEFT JOIN sale_items si
        ON si.sale_id = s.id
       AND si.tenant_id = s.tenant_id
      LEFT JOIN products p
        ON p.id = si.product_id
       AND p.tenant_id = si.tenant_id
      WHERE s.tenant_id = ?
        AND s.deleted_at IS NULL
        AND s.status IN ('completed', 'returned')
        AND COALESCE(s.completed_at, s.created_at) >= ?
        AND COALESCE(s.completed_at, s.created_at) <= ?
      GROUP BY s.id, s.completed_at, s.created_at, s.total
      ORDER BY COALESCE(s.completed_at, s.created_at) ASC
    `).all(tenantId, dateFrom, dateTo) as Array<{
      id: string
      occurred_at: string
      revenue: number
      cogs: number
      zero_cost_lines: number
    }>

    let totalRevenue = 0
    let totalCogs = 0
    const daily = new Map<string, { date: string; revenue: number; profit: number }>()
    for (const sale of sales) {
      const revenue = Number(sale.revenue ?? 0)
      const cogs = Number(sale.cogs ?? 0)
      const date = businessDateKey(sale.occurred_at)
      totalRevenue += revenue
      totalCogs += cogs
      if (!date) continue
      const current = daily.get(date) ?? { date, revenue: 0, profit: 0 }
      current.revenue += revenue
      current.profit += revenue - cogs
      daily.set(date, current)
    }

    // Returns belong to their own day, including returns of an earlier-period sale.
    // Only goods actually restored to stock reverse their cost of goods sold.
    const refunds = this.db.prepare(`SELECT r.id, r.created_at, r.refund_kopecks,
      COALESCE(SUM(CASE WHEN r.stock_action = 'return_to_stock' THEN ri.quantity * COALESCE(si.purchase_price, 0) ELSE 0 END), 0) cogs
      FROM customer_returns r
      LEFT JOIN customer_return_items ri ON ri.return_id = r.id AND ri.tenant_id = r.tenant_id AND ri.deleted_at IS NULL
      LEFT JOIN sale_items si ON si.id = ri.sale_item_id AND si.tenant_id = r.tenant_id
      WHERE r.tenant_id = ? AND r.deleted_at IS NULL AND r.status = 'completed' AND r.created_at >= ? AND r.created_at <= ?
      GROUP BY r.id`).all(tenantId, dateFrom, dateTo) as Array<{ created_at: string; refund_kopecks: number; cogs: number }>
    const grossRevenue = totalRevenue
    for (const refund of refunds) {
      totalRevenue -= Number(refund.refund_kopecks)
      totalCogs -= Number(refund.cogs)
      const date = businessDateKey(refund.created_at)
      const current = daily.get(date) ?? { date, revenue: 0, profit: 0 }
      current.revenue -= Number(refund.refund_kopecks)
      current.profit -= Number(refund.refund_kopecks) - Number(refund.cogs)
      daily.set(date, current)
    }
    return {
      analytics: {
        gross_revenue: grossRevenue,
        refund_total: grossRevenue - totalRevenue,
        expenses: null,
        net_profit: null,
        total_revenue: totalRevenue,
        cogs: totalCogs,
        gross_profit: totalRevenue - totalCogs,
        zero_cost_lines: sales.reduce((sum, sale) => sum + Number(sale.zero_cost_lines ?? 0), 0),
        total_receipts: sales.length,
        average_receipt: sales.length > 0 ? Math.round(totalRevenue / sales.length) : 0,
        daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
      },
      low_stock: Number(stats?.low_stock ?? 0),
      totals: {
        products: Number(stats?.products ?? 0),
        customers: Number(stats?.customers ?? 0),
        suppliers: Number(stats?.suppliers ?? 0),
        openOrders: Number(stats?.open_orders ?? 0),
      },
      overdue_count: Number(stats?.overdue_orders ?? 0),
      debt: {
        count: Number(stats?.debt_customers ?? 0),
        total: Number(stats?.debt_total ?? 0),
      },
      inventory: {
        purchase_value: Number(stats?.stock_purchase_value ?? 0),
        retail_value: Number(stats?.stock_retail_value ?? 0),
      },
    }
  }

  soldItemsReport(input: { tenant_id?: string; date_from: string; date_to: string }) {
    return readSoldItems(this.db, input.tenant_id ?? DEFAULT_TENANT_ID, input.date_from, input.date_to)
  }
}
