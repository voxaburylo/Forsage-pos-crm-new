import type { SaleListQuery } from '../validators/saleSchema.js'

/** Read-only receipt search: one snapshot, tenant-scoped EXISTS, no 1000-ID prefilter cap. */
export function saleHistoryQuery(input: SaleListQuery, tenantId: string) {
  const values: unknown[] = [tenantId]
  const bind = (value: unknown) => { values.push(value); return '$' + values.length }
  const where = ["s.tenant_id=$1", "to_jsonb(s)->>'deleted_at' IS NULL"]
  for (const field of ['shift_id', 'customer_id', 'sale_number', 'status'] as const) if (input[field]) where.push(`s.${field}=${bind(input[field])}`)
  const lineMatch = (alias: string, genericSearch = false) => {
    const checks = [`${alias}.tenant_id=s.tenant_id`, `to_jsonb(${alias})->>'deleted_at' IS NULL`]
    if (!genericSearch && input.product_id) checks.push(`${alias}.product_id=${bind(input.product_id)}::uuid`)
    if (!genericSearch && input.unit_price !== undefined) checks.push(`${alias}.unit_price=${bind(input.unit_price)}`)
    for (const token of (genericSearch ? input.search ?? '' : input.product_search ?? '').trim().toLocaleLowerCase('uk-UA').split(/\s+/).filter(Boolean)) {
      checks.push(`strpos(lower(COALESCE(to_jsonb(${alias})->>'description','') || ' ' || COALESCE(to_jsonb(${alias})->>'sku','') || ' ' ||
        COALESCE(p.name,'') || ' ' || COALESCE(p.sku,'') || ' ' || COALESCE(p.barcode,'') || ' ' ||
        COALESCE((SELECT string_agg(pb.barcode,' ') FROM product_barcodes pb WHERE pb.product_id=${alias}.product_id AND pb.tenant_id=s.tenant_id AND to_jsonb(pb)->>'deleted_at' IS NULL),'')),${bind(token)})>0`)
    }
    if (!genericSearch && input.product_barcode) {
      const code = bind(input.product_barcode.trim())
      checks.push(`(p.barcode=${code} OR p.sku=${code} OR to_jsonb(${alias})->>'sku'=${code} OR EXISTS(SELECT 1 FROM product_barcodes pb WHERE pb.product_id=${alias}.product_id AND pb.tenant_id=s.tenant_id AND to_jsonb(pb)->>'deleted_at' IS NULL AND pb.barcode=${code}))`)
    }
    return checks.join(' AND ')
  }
  const hasProduct = !!(input.product_id || input.product_search?.trim() || input.product_barcode || input.unit_price !== undefined)
  if (hasProduct) where.push(`EXISTS(SELECT 1 FROM sale_items si LEFT JOIN products p ON p.id=si.product_id AND p.tenant_id=si.tenant_id WHERE si.sale_id=s.id AND ${lineMatch('si')})`)
  if (input.seller_id) where.push(`COALESCE(s.manager_id::text,(SELECT o.manager_id::text FROM customer_orders o WHERE o.sale_id=s.id AND o.tenant_id=s.tenant_id AND to_jsonb(o)->>'deleted_at' IS NULL ORDER BY o.id LIMIT 1),s.cashier_id::text,'__unknown__')=${bind(input.seller_id)}`)
  if (input.search?.trim()) {
    const search = bind(input.search.trim().toLocaleLowerCase('uk-UA'))
    where.push(`(strpos(lower(s.sale_number),${search})>0 OR strpos(lower(COALESCE(c.phone,'') || ' ' || COALESCE(c.full_name,'') || ' ' || COALESCE(to_jsonb(c)->>'card_barcode','')),${search})>0
      OR EXISTS(SELECT 1 FROM customer_vehicles v WHERE v.customer_id=c.id AND v.tenant_id=s.tenant_id AND to_jsonb(v)->>'deleted_at' IS NULL AND strpos(lower(v.vin),${search})>0)
      OR EXISTS(SELECT 1 FROM customer_cars v WHERE v.customer_id=c.id AND v.tenant_id=s.tenant_id AND to_jsonb(v)->>'deleted_at' IS NULL AND strpos(lower(v.vin),${search})>0)
      OR EXISTS(SELECT 1 FROM sale_items si LEFT JOIN products p ON p.id=si.product_id AND p.tenant_id=si.tenant_id WHERE si.sale_id=s.id AND ${lineMatch('si', true)}))`)
  }
  const range = (field: string) => {
    const bounds = []
    if (input.date_from) bounds.push(`${field}>=${bind(input.date_from)}::timestamptz`)
    if (input.date_to) bounds.push(`${field}<=${bind(input.date_to)}::timestamptz`)
    if (input.date_to_exclusive) bounds.push(`${field}<${bind(input.date_to_exclusive)}::timestamptz`)
    return bounds.join(' AND ') || 'TRUE'
  }
  if (input.date_from || input.date_to || input.date_to_exclusive) {
    const saleRange = range('COALESCE(s.completed_at,s.created_at)')
    if (input.include_returns === '1') {
      const returnRange = range('r.created_at')
      const returnedProduct = hasProduct ? ` AND EXISTS(SELECT 1 FROM return_items ri JOIN sale_items rsi ON rsi.id=ri.sale_item_id AND rsi.tenant_id=ri.tenant_id LEFT JOIN products p ON p.id=rsi.product_id AND p.tenant_id=rsi.tenant_id WHERE ri.return_id=r.id AND ri.tenant_id=s.tenant_id AND to_jsonb(ri)->>'deleted_at' IS NULL AND ${lineMatch('rsi')})` : ''
      where.push(`((${saleRange}) OR EXISTS(SELECT 1 FROM returns r WHERE r.sale_id=s.id AND r.tenant_id=s.tenant_id AND r.status='completed' AND to_jsonb(r)->>'deleted_at' IS NULL AND ${returnRange}${returnedProduct}))`)
    } else where.push(saleRange)
  }
  if (input.include_returns === '1') where.push("s.status IN ('completed','returned')")
  const limit = bind(input.per_page), offset = bind((input.page - 1) * input.per_page)
  return { values, text: `WITH matched AS (
    SELECT s.*, CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id',c.id,'phone',c.phone,'full_name',c.full_name) END customer
    FROM sales s LEFT JOIN customers c ON c.id=s.customer_id AND c.tenant_id=s.tenant_id WHERE ${where.join(' AND ')}
  ), page_rows AS (SELECT * FROM matched ORDER BY COALESCE(completed_at,created_at) DESC,id DESC LIMIT ${limit} OFFSET ${offset})
  SELECT (SELECT count(*)::integer FROM matched) total,
    COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY COALESCE(p.completed_at,p.created_at) DESC,p.id DESC) FROM page_rows p),'[]'::jsonb) data` }
}
