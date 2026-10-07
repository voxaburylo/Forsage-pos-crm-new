import type { LocalDatabase } from '../../db/localDatabase'
import { aggregatePeriod, periodDate, type PeriodSnapshot } from '../../lib/periodReport'
import { validSoldDateRange } from '../../lib/soldItems'

export function readPeriodReport(db: LocalDatabase,tenantId: string,from: string,to: string) {
  const valid = (value: string) => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value)) && validSoldDateRange(value.slice(0,10),value.slice(0,10))
  if (!valid(from) || !valid(to) || Date.parse(from)>Date.parse(to)) throw new Error('Некоректний період звіту')
  const args = [tenantId,new Date(from).toISOString(),new Date(to).toISOString()]
  return db.readSnapshot(() => {
    const scope = `WITH selected_sales AS (
      SELECT id FROM sales WHERE tenant_id=?1 AND deleted_at IS NULL AND status IN ('completed','returned')
        AND julianday(COALESCE(completed_at,created_at))>=julianday(?2)
        AND julianday(COALESCE(completed_at,created_at))<=julianday(?3)
    ), selected_returns AS (
      SELECT id,sale_id,created_at,refund_kopecks amount,stock_action FROM customer_returns
      WHERE tenant_id=?1 AND deleted_at IS NULL AND status='completed'
        AND julianday(created_at)>=julianday(?2) AND julianday(created_at)<=julianday(?3)
    ), selected_payments AS (
      SELECT id,order_id,amount,method,created_at FROM order_payments
      WHERE tenant_id=?1 AND deleted_at IS NULL AND julianday(created_at)>=julianday(?2) AND julianday(created_at)<=julianday(?3)
    ), relevant_ids AS (
      SELECT id FROM selected_sales UNION SELECT sale_id FROM selected_returns
    ), relevant_sales AS (
      SELECT s.id,s.sale_number,s.status,s.total,COALESCE(s.completed_at,s.created_at) completed_at,
        s.payment_method,s.cash_amount,s.card_amount,s.transfer_amount,s.debt_amount,s.is_debt,s.customer_id,
        CASE WHEN c.id IS NULL THEN NULL ELSE json_object('id',c.id,'phone',c.phone,'full_name',c.full_name) END customer,
        EXISTS(SELECT 1 FROM selected_sales d WHERE d.id=s.id) selected
      FROM sales s JOIN relevant_ids i ON i.id=s.id
      LEFT JOIN customers c ON c.id=s.customer_id AND c.tenant_id=?1
      WHERE s.tenant_id=?1 AND s.deleted_at IS NULL AND s.status IN ('completed','returned')
    ) `
    const query = (sql: string) => db.prepare(scope+sql).all(...args)
    const sales = query('SELECT * FROM relevant_sales').map((s:any) => ({
      ...s, selected:Boolean(s.selected),is_debt:Boolean(s.is_debt),customer:s.customer ? JSON.parse(s.customer) : null,
    }))
    const lines = query(`SELECT si.id,si.sale_id,si.qty,si.total,si.purchase_price cost FROM sale_items si
      JOIN relevant_sales s ON s.id=si.sale_id WHERE si.tenant_id=?1 AND si.deleted_at IS NULL`)
    const returns = query('SELECT * FROM selected_returns')
    const refundLines = query(`SELECT ri.id,ri.return_id,ri.sale_item_id,ri.quantity,ri.total_kopecks FROM customer_return_items ri
      JOIN selected_returns r ON r.id=ri.return_id WHERE ri.tenant_id=?1 AND ri.deleted_at IS NULL`)
    const orders = query(`SELECT o.id,o.sale_id FROM customer_orders o WHERE o.tenant_id=?1 AND
      (o.sale_id IN (SELECT id FROM relevant_sales) OR o.id IN (SELECT order_id FROM selected_payments))`)
    const payments = query('SELECT * FROM selected_payments')
    return aggregatePeriod({sales,lines,returns,refundLines,orders,payments} as PeriodSnapshot,periodDate(from),periodDate(to))
  })
}
