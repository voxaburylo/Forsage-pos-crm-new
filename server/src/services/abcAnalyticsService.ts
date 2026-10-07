import { z } from 'zod'
import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { kyivDateKey, kyivDateRange } from '../lib/businessDate.js'
import { allocateReceiptRevenue } from '../lib/receiptRevenue.js'

const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const item = z.object({
  id: z.string(), product_id: z.string().nullable(), qty: z.number().finite().positive(),
  total: money, cost_price: money, coreTotal: money,
})
const snapshotSchema = z.object({
  products: z.array(z.object({
    id: z.string(), sku: z.string().nullable(), name: z.string(),
    currentStock: z.number().finite(), is_active: z.boolean(), is_service: z.boolean(),
    deleted_at: z.string().nullable(),
  })),
  sales: z.array(z.object({ id: z.string(), total: money, items: z.array(item).min(1) })),
  returns: z.array(z.object({
    id: z.string(), amount: money, stock_action: z.enum(['return_to_stock', 'write_off', 'send_to_supplier']),
    items: z.array(z.object({
      id: z.string(), product_id: z.string().nullable(), quantity: z.number().finite().positive(),
      total_kopecks: money, source_id: z.string(), source_product_id: z.string().nullable(),
      cost_price: money, source_sale_id: z.string(),
    })).min(1),
  })),
})

// A single statement reads a consistent snapshot. Filter the receipt BEFORE its
// lines are aggregated; a filter on a LEFT JOIN must not let old lines leak in.
const abcSql = `
  WITH selected_sales AS (
    SELECT id, tenant_id, total FROM sales
    WHERE tenant_id=$1 AND status IN ('completed','returned')
      AND COALESCE(completed_at,created_at) >= $2::timestamptz
      AND COALESCE(completed_at,created_at) < $3::timestamptz
  ), sale_lines AS (
    SELECT si.sale_id, jsonb_agg(jsonb_build_object(
      'id',si.id,'product_id',si.product_id,'qty',si.qty,'total',si.total,
      'cost_price',si.cost_price,'coreTotal',ROUND(si.qty*COALESCE(si.core_deposit_amount,0))
    ) ORDER BY si.id) items
    FROM sale_items si JOIN selected_sales s ON s.id=si.sale_id AND s.tenant_id=si.tenant_id
    WHERE si.tenant_id=$1 GROUP BY si.sale_id
  ), selected_returns AS (
    SELECT id, tenant_id, sale_id, stock_action, COALESCE(refund_kopecks,refund_amount) amount
    FROM returns WHERE tenant_id=$1 AND status='completed'
      AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
  ), return_lines AS (
    SELECT r.id return_id, jsonb_agg(jsonb_build_object(
      'id',ri.id,'product_id',ri.product_id,'quantity',ri.quantity,'total_kopecks',ri.total_kopecks,
      'source_id',si.id,'source_product_id',si.product_id,'cost_price',si.cost_price,'source_sale_id',s.id
    ) ORDER BY ri.id) items
    FROM selected_returns r JOIN return_items ri ON ri.return_id=r.id AND ri.tenant_id=r.tenant_id
    LEFT JOIN sale_items si ON si.id=ri.sale_item_id AND si.tenant_id=r.tenant_id AND si.sale_id=r.sale_id
    LEFT JOIN sales s ON s.id=r.sale_id AND s.tenant_id=r.tenant_id AND s.status IN ('completed','returned')
    GROUP BY r.id
  )
  SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',p.id,'sku',p.sku,'name',p.name,'currentStock',p.qty_on_hand,
      'is_active',p.is_active,'is_service',p.is_service,'deleted_at',p.deleted_at
    )) FROM products p WHERE p.tenant_id=$1),'[]'::jsonb) products,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',s.id,'total',s.total,'items',COALESCE(l.items,'[]'::jsonb)
    )) FROM selected_sales s LEFT JOIN sale_lines l ON l.sale_id=s.id),'[]'::jsonb) sales,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',r.id,'amount',r.amount,'stock_action',r.stock_action,'items',COALESCE(l.items,'[]'::jsonb)
    )) FROM selected_returns r LEFT JOIN return_lines l ON l.return_id=r.id),'[]'::jsonb) returns
`

function incompleteReport(): never {
  throw new AppError('INCOMPLETE_REPORT', 'Дані товарного звіту неповні або не узгоджені. Оновіть резервну копію та повторіть перевірку.', 503)
}

export async function getAbcAnalytics(query: unknown, tenantId: string) {
  const parsed = z.object({
    days: z.string().regex(/^[1-9]\d*$/).default('90').transform(Number)
      .refine(value => Number.isSafeInteger(value) && value <= 3660),
  }).safeParse(query)
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Невірна кількість днів для звіту', 400)
  const endDate = kyivDateKey()
  // Calendar days, not rolling 24-hour intervals: today is one of the N days.
  const start = new Date(endDate + 'T12:00:00Z')
  start.setUTCDate(start.getUTCDate() - parsed.data.days + 1)
  const { from, toExclusive } = kyivDateRange(start.toISOString().slice(0, 10), endDate)
  const result = await pool.query(abcSql, [tenantId, from, toExclusive])
  const checked = snapshotSchema.safeParse(result.rows[0])
  if (!checked.success) incompleteReport()
  const snapshot = checked.data
  const products = new Map(snapshot.products.map(product => [product.id, product]))
  const entries: { product_id: string | null; qty: number; revenue: number; cost: number }[] = []
  for (const sale of snapshot.sales) {
    let revenue: Map<string, number>
    try { revenue = allocateReceiptRevenue(sale.total, sale.items) } catch { incompleteReport() }
    for (const line of sale.items) entries.push({
      product_id: line.product_id, qty: line.qty, revenue: revenue.get(line.id)!,
      cost: line.qty * line.cost_price,
    })
  }
  for (const returned of snapshot.returns) {
    if (returned.items.reduce((sum, line) => sum + line.total_kopecks, 0) !== returned.amount) incompleteReport()
    for (const line of returned.items) {
      if (line.product_id !== line.source_product_id) incompleteReport()
      entries.push({ product_id: line.product_id, qty: -line.quantity, revenue: -line.total_kopecks,
        cost: returned.stock_action === 'return_to_stock' ? -line.quantity * line.cost_price : 0 })
    }
  }
  const involved = new Set(entries.map(line => line.product_id))
  for (const id of involved) if (id !== null && !products.has(id)) incompleteReport()
  const rows = new Map(snapshot.products.filter(product => !product.is_service
    && ((product.is_active && product.deleted_at === null) || involved.has(product.id)))
    .map(product => [product.id, {
      id: product.id, sku: product.sku ?? '', name: product.name, currentStock: product.currentStock,
      soldQty: 0, profit: 0,
    }]))
  // Services/free-price lines were included in the receipt allocation above;
  // excluding them here must not move their discount share onto stock goods.
  for (const line of entries) {
    const product = line.product_id ? rows.get(line.product_id) : undefined
    if (!product) continue
    product.soldQty = Math.round((product.soldQty + line.qty) * 1000) / 1000
    product.profit += line.revenue - line.cost
  }
  // Keep these rules aligned with localAnalytics: the item crossing a band
  // remains in that band. A single dominant product must not become class C.
  const ranked = [...rows.values()].sort((a, b) => b.profit - a.profit || a.id.localeCompare(b.id))
  const total = ranked.reduce((sum, row) => sum + Math.max(0, row.profit), 0)
  let cumulative = 0
  return ranked.map(row => {
    const before = total ? cumulative / total : 0
    cumulative += Math.max(0, row.profit)
    return { ...row, profit: Math.round(row.profit), cumulative_pct: total ? 100 * cumulative / total : 0,
      abc_class: row.soldQty <= 0 || row.profit <= 0 ? 'Z' : before < .8 ? 'A' : before < .95 ? 'B' : 'C' }
  })
}
