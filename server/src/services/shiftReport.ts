import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { aggregateShiftSnapshot } from '../lib/shiftReport.js'

// A single statement gives all components the same database snapshot and avoids REST row caps.
// Old returns may lack shift_id: use an exact cash link first, then only an unambiguous
// cashier/time interval. Never assign a refund to the original receipt's shift.
const shiftSql = `
WITH target AS (
 SELECT * FROM shifts s WHERE tenant_id=$1 AND id=$2 AND to_jsonb(s)->>'deleted_at' IS NULL
), shift_sales AS (
 SELECT s.id,s.sale_number,s.total,s.payment_method,s.status,s.completed_at,s.is_fiscal,
   s.cash_amount,s.card_amount,s.transfer_amount,s.debt_amount,s.is_debt
 FROM sales s JOIN target t ON t.id=s.shift_id
 WHERE s.tenant_id=$1 AND to_jsonb(s)->>'deleted_at' IS NULL
), shift_payments AS (
 SELECT p.* FROM order_payments p JOIN target t ON t.id=p.shift_id
 WHERE p.tenant_id=$1 AND to_jsonb(p)->>'deleted_at' IS NULL
), cash_rows AS (
 SELECT c.* FROM cash_operations c JOIN target t ON t.id=c.shift_id
 WHERE c.tenant_id=$1 AND to_jsonb(c)->>'deleted_at' IS NULL
), refund_rows AS (
 SELECT r.id,r.sale_id,r.refund_method,COALESCE(r.refund_kopecks,r.refund_amount) amount,
   to_jsonb(r)->>'shift_id' shift_id,COALESCE((to_jsonb(r)->>'shift_link_recorded')::boolean,false) shift_link_recorded,
   c.shift_id cash_shift_id,c.amount cash_amount,
   s.total sale_total,
   ARRAY(SELECT sh.id::text FROM shifts sh WHERE sh.tenant_id=$1
     AND to_jsonb(sh)->>'deleted_at' IS NULL AND sh.status IN ('open','closed')
     AND (sh.id::text=to_jsonb(r)->>'shift_id' OR sh.id=c.shift_id)) known_links,
   ARRAY(SELECT sh.id::text FROM shifts sh WHERE sh.tenant_id=$1
     AND to_jsonb(sh)->>'deleted_at' IS NULL AND sh.status IN ('open','closed')
     AND sh.cashier_id=r.approved_by AND r.created_at>=sh.opened_at
     AND r.created_at<=COALESCE(sh.closed_at,CURRENT_TIMESTAMP)) intervals
 FROM returns r CROSS JOIN target t
 LEFT JOIN cash_operations c ON c.id=r.id AND c.tenant_id=$1 AND c.type='out'
   AND r.refund_method='cash' AND to_jsonb(c)->>'deleted_at' IS NULL
 LEFT JOIN sales s ON s.id=r.sale_id AND s.tenant_id=$1
   AND s.status IN ('completed','returned') AND to_jsonb(s)->>'deleted_at' IS NULL
 WHERE r.tenant_id=$1 AND r.status='completed' AND to_jsonb(r)->>'deleted_at' IS NULL
   AND (to_jsonb(r)->>'shift_id'=t.id::text OR c.shift_id=t.id
     OR (r.created_at>=t.opened_at
       AND r.created_at<=COALESCE(t.closed_at,CURRENT_TIMESTAMP)))
)
SELECT (SELECT to_jsonb(t) FROM target t) shift,
 COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.completed_at,s.id) FROM shift_sales s),'[]'::jsonb) sales,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',o.id,'sale_id',o.sale_id)) FROM customer_orders o
   WHERE o.tenant_id=$1 AND (o.sale_id IN (SELECT id FROM shift_sales) OR o.id IN (SELECT order_id FROM shift_payments))),'[]'::jsonb) orders,
 COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM shift_payments p),'[]'::jsonb) payments,
 COALESCE((SELECT jsonb_agg(to_jsonb(c) || jsonb_build_object('refund',
   CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('method',r.refund_method,
     'status',r.status,'amount',COALESCE(r.refund_kopecks,r.refund_amount)) END))
   FROM cash_rows c LEFT JOIN returns r ON r.id=c.id AND r.tenant_id=$1
     AND to_jsonb(r)->>'deleted_at' IS NULL),'[]'::jsonb) operations,
 COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM refund_rows r),'[]'::jsonb) refunds
`

export async function readShiftReport(shiftId: string, tenantId: string) {
 const result = await pool.query(shiftSql,[tenantId,shiftId])
 if (result.rows[0]?.shift === null) throw new AppError('SHIFT_NOT_FOUND','Зміну не знайдено',404)
 try { return aggregateShiftSnapshot(result.rows[0],shiftId,tenantId) }
 catch { throw new AppError('INCOMPLETE_REPORT','Звіт зміни містить неповні або неузгоджені дані. Перевірте серверну копію.',503) }
}
