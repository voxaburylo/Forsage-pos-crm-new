import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { kyivDateRange } from '../lib/businessDate.js'
import { aggregateSoldItems, validSoldDateRange, type SoldSnapshot } from '../lib/soldItems.js'

// A single SELECT supplies sales, dated refunds, source receipts and metadata.
// No page cap or later supplier query can produce a mixed/partial report.
const soldSql = `
WITH selected_returns AS (
  SELECT r.id,r.sale_id,COALESCE(r.refund_kopecks,r.refund_amount) amount FROM returns r
  WHERE r.tenant_id=$1 AND r.status='completed' AND to_jsonb(r)->>'deleted_at' IS NULL
    AND r.created_at>=$2::timestamptz AND r.created_at<$3::timestamptz
), selected_sales AS (
  SELECT s.id FROM sales s WHERE s.tenant_id=$1 AND s.status IN ('completed','returned')
    AND to_jsonb(s)->>'deleted_at' IS NULL
    AND COALESCE(s.completed_at,s.created_at)>=$2::timestamptz
    AND COALESCE(s.completed_at,s.created_at)<$3::timestamptz
), relevant_ids AS (
  SELECT id FROM selected_sales UNION SELECT sale_id FROM selected_returns
), relevant_sales AS (
  SELECT s.id,s.total,s.manager_id,s.cashier_id,EXISTS(SELECT 1 FROM selected_sales d WHERE d.id=s.id) selected
  FROM sales s JOIN relevant_ids r ON r.id=s.id
  WHERE s.tenant_id=$1 AND s.status IN ('completed','returned') AND to_jsonb(s)->>'deleted_at' IS NULL
), lines AS (
  SELECT si.id,si.sale_id,si.product_id,si.qty,si.total,ROUND(si.qty*COALESCE(si.core_deposit_amount,0)) "coreTotal"
  FROM sale_items si JOIN relevant_sales s ON s.id=si.sale_id
  WHERE si.tenant_id=$1 AND to_jsonb(si)->>'deleted_at' IS NULL
), relevant_products AS (
  SELECT DISTINCT product_id FROM lines WHERE product_id IS NOT NULL
), product_rows AS (
  SELECT p.id,COALESCE(p.sku,'') sku,COALESCE(NULLIF(p.barcode,''),(SELECT pb.barcode FROM product_barcodes pb
    WHERE pb.tenant_id=$1 AND pb.product_id=p.id AND to_jsonb(pb)->>'deleted_at' IS NULL
    ORDER BY pb.is_primary DESC,pb.created_at,pb.id LIMIT 1)) barcode,
    p.name,p.unit,p.qty_on_hand,p.storage_bin,COALESCE(p.is_service,false) is_service
  FROM products p JOIN relevant_products r ON r.product_id=p.id WHERE p.tenant_id=$1
), supplier_rows AS (
  SELECT DISTINCT ii.product_id,s.id,s.name FROM supply_invoice_items ii
  JOIN relevant_products p ON p.product_id=ii.product_id
  JOIN supply_invoices i ON i.id=ii.invoice_id AND i.tenant_id=ii.tenant_id
  JOIN suppliers s ON s.id=i.supplier_id AND s.tenant_id=i.tenant_id
  WHERE ii.tenant_id=$1 AND ii.qty>0 AND to_jsonb(ii)->>'deleted_at' IS NULL
    AND i.status='posted' AND i.deleted_at IS NULL AND s.deleted_at IS NULL
)
SELECT
  COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM relevant_sales s),'[]'::jsonb) sales,
  COALESCE((SELECT jsonb_agg(to_jsonb(l)) FROM lines l),'[]'::jsonb) lines,
  COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM selected_returns r),'[]'::jsonb) returns,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',ri.id,'return_id',ri.return_id,'sale_item_id',ri.sale_item_id,
    'product_id',ri.product_id,'quantity',ri.quantity,'total_kopecks',ri.total_kopecks))
    FROM return_items ri JOIN selected_returns r ON r.id=ri.return_id
    WHERE ri.tenant_id=$1 AND to_jsonb(ri)->>'deleted_at' IS NULL),'[]'::jsonb) "refundLines",
  COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM product_rows p),'[]'::jsonb) products,
  COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM supplier_rows s),'[]'::jsonb) suppliers,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',raw_user_meta_data->>'full_name')) FROM auth.users
    WHERE raw_app_meta_data->>'tenant_id'=$1::text),'[]'::jsonb) staff,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',o.id,'sale_id',o.sale_id,'manager_id',o.manager_id))
    FROM customer_orders o JOIN relevant_sales s ON s.id=o.sale_id
    WHERE o.tenant_id=$1 AND to_jsonb(o)->>'deleted_at' IS NULL),'[]'::jsonb) orders
`

export async function getSoldItems(from: string, to: string, tenantId: string) {
  if (!validSoldDateRange(from,to)) throw new AppError('VALIDATION_ERROR','Невірно вибраний період',400)
  const range = kyivDateRange(from,to)
  const snapshot = await pool.query(soldSql,[tenantId,range.from,range.toExclusive])
  try { return aggregateSoldItems(snapshot.rows[0] as SoldSnapshot) }
  catch { throw new AppError('INCOMPLETE_REPORT','Звіт проданих товарів містить неповні або неузгоджені дані. Перевірте чеки та резервну копію.',503) }
}
