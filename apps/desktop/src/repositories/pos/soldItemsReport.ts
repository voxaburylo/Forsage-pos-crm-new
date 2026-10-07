import type { LocalDatabase } from '../../db/localDatabase'
import { aggregateSoldItems, validSoldDateRange, type SoldSnapshot } from '../../lib/soldItems'
import { soldItemSuppliers } from './soldItemSuppliers'

export function readSoldItems(db: LocalDatabase, tenantId: string, from: string, to: string) {
  // IPC historically accepts inclusive UTC bounds. Normalize them once and
  // compare actual instants (legacy rows may omit milliseconds/use an offset).
  const valid = (value: string) => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value)) && validSoldDateRange(value.slice(0,10),value.slice(0,10))
  if (!valid(from) || !valid(to) || Date.parse(from)>Date.parse(to)) throw new Error('Некоректний період звіту')
  const args = [tenantId,new Date(from).toISOString(),new Date(to).toISOString()]
  return db.readSnapshot(() => {
    const scope = `WITH selected_returns AS (
      SELECT r.id,r.sale_id,r.refund_kopecks amount FROM customer_returns r
      WHERE r.tenant_id=?1 AND r.deleted_at IS NULL AND r.status='completed'
        AND julianday(r.created_at)>=julianday(?2) AND julianday(r.created_at)<=julianday(?3)
    ), selected_sales AS (
      SELECT s.id FROM sales s WHERE s.tenant_id=?1 AND s.deleted_at IS NULL AND s.status IN ('completed','returned')
        AND julianday(COALESCE(s.completed_at,s.created_at))>=julianday(?2)
        AND julianday(COALESCE(s.completed_at,s.created_at))<=julianday(?3)
    ), relevant_ids AS (
      SELECT id FROM selected_sales UNION SELECT sale_id FROM selected_returns
    ), relevant_sales AS (
      SELECT s.id,s.total,s.manager_id,s.cashier_id,EXISTS(SELECT 1 FROM selected_sales d WHERE d.id=s.id) selected
      FROM sales s JOIN relevant_ids r ON r.id=s.id
      WHERE s.tenant_id=?1 AND s.deleted_at IS NULL AND s.status IN ('completed','returned')
    ), lines AS (
      SELECT si.id,si.sale_id,si.product_id,si.qty,si.total,CAST(ROUND(si.qty*COALESCE(si.core_deposit_amount,0)) AS INTEGER) coreTotal
      FROM sale_items si JOIN relevant_sales s ON s.id=si.sale_id WHERE si.tenant_id=?1 AND si.deleted_at IS NULL
    ) `
    const query = (sql: string) => db.prepare(scope+sql).all(...args)
    const sales = query('SELECT * FROM relevant_sales').map((row: any) => ({...row,selected:Boolean(row.selected)}))
    const lines = query('SELECT * FROM lines')
    const returns = query('SELECT * FROM selected_returns')
    const refundLines = query(`SELECT ri.id,ri.return_id,ri.sale_item_id,ri.product_id,ri.quantity,ri.total_kopecks
      FROM customer_return_items ri JOIN selected_returns r ON r.id=ri.return_id
      WHERE ri.tenant_id=?1 AND ri.deleted_at IS NULL`)
    const products = query(`SELECT p.id,p.sku,p.name,p.unit,p.qty_on_hand,p.storage_bin,p.is_service,
      COALESCE(NULLIF(p.barcode,''),(SELECT pb.barcode FROM product_barcodes pb
        WHERE pb.tenant_id=?1 AND pb.product_id=p.id AND pb.deleted_at IS NULL
        ORDER BY pb.is_primary DESC,pb.created_at,pb.id LIMIT 1)) barcode
      FROM products p WHERE p.tenant_id=?1 AND p.id IN (SELECT product_id FROM lines)`)
      .map((row: any) => ({...row,is_service:Boolean(row.is_service)}))
    const orders = query(`SELECT o.id,o.sale_id,o.manager_id FROM customer_orders o
      JOIN relevant_sales s ON s.id=o.sale_id WHERE o.tenant_id=?1 AND o.deleted_at IS NULL`)
    const staff = db.prepare('SELECT id,full_name name FROM staff_users WHERE tenant_id=?').all(tenantId)
    const supplierMap = soldItemSuppliers(db,tenantId,products.map(row=>row.id))
    const suppliers = [...supplierMap].flatMap(([product_id,rows])=>rows.map(row=>({...row,product_id})))
    return aggregateSoldItems({sales,lines,returns,refundLines,products,orders,staff,suppliers} as SoldSnapshot)
  })
}
