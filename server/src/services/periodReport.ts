import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { kyivDateRange } from '../lib/businessDate.js'
import { validSoldDateRange } from '../lib/soldItems.js'
import { aggregatePeriod, type PeriodSnapshot } from '../lib/periodReport.js'

// One statement, one MVCC snapshot; there is no REST row cap or per-receipt query.
const periodSql = `
WITH selected_sales AS (
  SELECT id FROM sales s WHERE tenant_id=$1 AND status IN ('completed','returned')
    AND to_jsonb(s)->>'deleted_at' IS NULL AND COALESCE(completed_at,created_at)>=$2::timestamptz
    AND COALESCE(completed_at,created_at)<$3::timestamptz
), selected_returns AS (
  SELECT r.id,r.sale_id,r.created_at,COALESCE(r.refund_kopecks,r.refund_amount) amount,r.stock_action FROM returns r
  WHERE tenant_id=$1 AND status='completed' AND to_jsonb(r)->>'deleted_at' IS NULL
    AND created_at>=$2::timestamptz AND created_at<$3::timestamptz
), selected_payments AS (
  SELECT p.id,p.order_id,p.amount,p.method,p.created_at FROM order_payments p
  WHERE tenant_id=$1 AND to_jsonb(p)->>'deleted_at' IS NULL
    AND created_at>=$2::timestamptz AND created_at<$3::timestamptz
), relevant_ids AS (
  SELECT id FROM selected_sales UNION SELECT sale_id FROM selected_returns
), relevant_sales AS (
  SELECT s.id,s.sale_number,s.status,s.total,COALESCE(s.completed_at,s.created_at) completed_at,
    s.payment_method,s.cash_amount,s.card_amount,s.transfer_amount,s.debt_amount,COALESCE(s.is_debt,false) is_debt,
    s.customer_id,CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id',c.id,'phone',c.phone,'full_name',c.full_name) END customer,
    EXISTS(SELECT 1 FROM selected_sales d WHERE d.id=s.id) selected
  FROM sales s JOIN relevant_ids i ON i.id=s.id
  LEFT JOIN customers c ON c.id=s.customer_id AND c.tenant_id=$1
  WHERE s.tenant_id=$1 AND s.status IN ('completed','returned') AND to_jsonb(s)->>'deleted_at' IS NULL
)
SELECT
  COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM relevant_sales s),'[]'::jsonb) sales,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',si.id,'sale_id',si.sale_id,'qty',si.qty,'total',si.total,'cost',si.cost_price))
    FROM sale_items si JOIN relevant_sales s ON s.id=si.sale_id
    WHERE si.tenant_id=$1 AND to_jsonb(si)->>'deleted_at' IS NULL),'[]'::jsonb) lines,
  COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM selected_returns r),'[]'::jsonb) returns,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',ri.id,'return_id',ri.return_id,'sale_item_id',ri.sale_item_id,
    'quantity',ri.quantity,'total_kopecks',ri.total_kopecks)) FROM return_items ri JOIN selected_returns r ON r.id=ri.return_id
    WHERE ri.tenant_id=$1 AND to_jsonb(ri)->>'deleted_at' IS NULL),'[]'::jsonb) "refundLines",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',o.id,'sale_id',o.sale_id)) FROM customer_orders o
    WHERE o.tenant_id=$1 AND (o.sale_id IN (SELECT id FROM relevant_sales) OR o.id IN (SELECT order_id FROM selected_payments))),'[]'::jsonb) orders,
  COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM selected_payments p),'[]'::jsonb) payments
`
export async function readPeriodReport(from: string,to: string,tenantId: string) {
  if (!validSoldDateRange(from,to)) throw new AppError('VALIDATION_ERROR','Невірно вибраний період',400)
  const range = kyivDateRange(from,to)
  const result = await pool.query(periodSql,[tenantId,range.from,range.toExclusive])
  try { return aggregatePeriod(result.rows[0] as PeriodSnapshot,from,to) }
  catch (error) { throw new AppError('INCOMPLETE_REPORT',error instanceof Error ? error.message : 'Неповний звіт',503) }
}
