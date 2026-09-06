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

export class LocalPosReports extends LocalPosFiscal {
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
            THEN COALESCE(NULLIF(si.purchase_price, 0), p.purchase_price, 0) * COALESCE(si.qty, 0)
            ELSE 0
          END
        ), 0) AS cogs
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

    return {
      analytics: {
        total_revenue: totalRevenue,
        cogs: totalCogs,
        gross_profit: totalRevenue - totalCogs,
        total_receipts: sales.length,
        average_receipt: sales.length > 0 ? Math.round(totalRevenue / sales.length) : 0,
        daily: [...daily.values()],
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

  soldItemsReport(input: { tenant_id?: string; date_from: string; date_to: string }): any[] {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const dateFrom = String(input.date_from ?? '').trim()
    const dateTo = String(input.date_to ?? '').trim()
    if (!dateFrom || !dateTo) throw new Error('Analytics period is required')

    const rows = this.db.prepare(`
      WITH selected_sales AS (
        SELECT id, tenant_id
        FROM sales
        WHERE tenant_id = ?
          AND deleted_at IS NULL
          AND status IN ('completed', 'returned')
          AND COALESCE(completed_at, created_at) >= ?
          AND COALESCE(completed_at, created_at) <= ?
      ),
      sold AS (
        SELECT
          si.product_id,
          COALESCE(p.sku, si.sku, '') AS sku,
          COALESCE(
            NULLIF(p.barcode, ''),
            (SELECT pb.barcode
             FROM product_barcodes pb
             WHERE pb.tenant_id = si.tenant_id
               AND pb.product_id = si.product_id
               AND pb.deleted_at IS NULL
             ORDER BY pb.is_primary DESC, pb.created_at ASC
             LIMIT 1),
            ''
          ) AS barcode,
          COALESCE(p.name, si.description, '(товар видалено)') AS name,
          COALESCE(p.unit, 'шт') AS unit,
          COALESCE(p.qty_on_hand, 0) AS qty_on_hand,
          p.storage_bin,
          SUM(si.qty) AS qty_sold,
          SUM(si.total) AS revenue
        FROM selected_sales ss
        JOIN sale_items si
          ON si.sale_id = ss.id
         AND si.tenant_id = ss.tenant_id
         AND si.deleted_at IS NULL
        LEFT JOIN products p
          ON p.id = si.product_id
         AND p.tenant_id = si.tenant_id
        WHERE si.product_id IS NOT NULL
          AND COALESCE(p.is_service, 0) = 0
        GROUP BY
          si.product_id, COALESCE(p.sku, si.sku, ''), p.barcode,
          COALESCE(p.name, si.description, '(товар видалено)'),
          COALESCE(p.unit, 'шт'), COALESCE(p.qty_on_hand, 0), p.storage_bin,
          si.tenant_id
      ),
      returned AS (
        SELECT
          ri.product_id,
          SUM(ri.quantity) AS qty_returned,
          SUM(ri.total_kopecks) AS refund_total
        FROM customer_return_items ri
        JOIN customer_returns r
          ON r.id = ri.return_id
         AND r.tenant_id = ri.tenant_id
         AND r.deleted_at IS NULL
         AND r.status = 'completed'
        JOIN selected_sales ss
          ON ss.id = r.sale_id
         AND ss.tenant_id = r.tenant_id
        WHERE ri.tenant_id = ?
          AND ri.deleted_at IS NULL
        GROUP BY ri.product_id
      )
      SELECT
        sold.product_id,
        sold.sku,
        NULLIF(sold.barcode, '') AS barcode,
        sold.name,
        sold.unit,
        sold.qty_sold,
        COALESCE(returned.qty_returned, 0) AS qty_returned,
        MAX(sold.qty_sold - COALESCE(returned.qty_returned, 0), 0) AS qty_net,
        sold.revenue,
        COALESCE(returned.refund_total, 0) AS refund_total,
        MAX(sold.revenue - COALESCE(returned.refund_total, 0), 0) AS net_revenue,
        sold.qty_on_hand,
        sold.storage_bin
      FROM sold
      LEFT JOIN returned ON returned.product_id = sold.product_id
      ORDER BY qty_net DESC, sold.name COLLATE NOCASE ASC
    `).all(tenantId, dateFrom, dateTo, tenantId) as any[]

    return rows.map((row) => ({
      ...row,
      qty_sold: Number(row.qty_sold ?? 0),
      qty_returned: Number(row.qty_returned ?? 0),
      qty_net: Number(row.qty_net ?? 0),
      revenue: Number(row.revenue ?? 0),
      refund_total: Number(row.refund_total ?? 0),
      net_revenue: Number(row.net_revenue ?? 0),
      qty_on_hand: Number(row.qty_on_hand ?? 0),
    }))
  }
}
