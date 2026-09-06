import type { ProductListQuery } from '../validators/productValidator.js'
import { normalizeArticle, normalizeOemValue } from '../validators/productValidator.js'

// All values are parameters. ORDER BY identifiers are selected only from this map.
// Pagination runs AFTER availability/reserves and filters, never over separate
// stock groups or a truncated list of related product IDs.
export function catalogListQuery(filters: ProductListQuery, tenantId: string, terms: string[]) {
  const values: unknown[] = [tenantId]
  const bind = (value: unknown) => { values.push(value); return `$${values.length}` }
  const contains = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`
  const where = ['p.tenant_id = $1', 'p.deleted_at IS NULL']
  where.push(`p.is_active = ${bind(filters.is_active !== 'false')}`)
  if (filters.category_id === '__uncategorized') where.push('p.category_id IS NULL')
  else if (filters.category_id) where.push(`p.category_id = ${bind(filters.category_id)}`)
  if (filters.brand_id) where.push(`p.brand_id = ${bind(filters.brand_id)}`)
  if (filters.low_stock === 'true') where.push('p.qty_on_hand <= p.reorder_point')
  if (filters.stock_filter === 'negative') where.push('p.qty_on_hand < 0')
  if (filters.stock_filter === 'no_price') where.push('p.retail_price = 0')

  const raw = filters.search?.trim() ?? ''
  let exactOrder = ''
  if (raw) {
    const oemOnly = raw.startsWith('oem:')
    const source = oemOnly ? raw.slice(4).trim() : raw
    const patterns = bind([...new Set((oemOnly ? [normalizeOemValue(source)] : terms)
      .map(t => t.trim()).filter(Boolean).map(contains))])
    const codes = bind([...new Set((oemOnly ? [source] : terms)
      .map(normalizeArticle).filter(Boolean).map(contains))])
    const exact = bind(source)
    const compact = bind(normalizeArticle(source))
    const predicates = [
      `p.normalized_oem ILIKE ANY(${codes}::text[])`,
      `p.normalized_supplier_article ILIKE ANY(${codes}::text[])`,
      `p.oem_number ILIKE ANY(${codes}::text[])`,
      `EXISTS (SELECT 1 FROM product_cross_numbers x WHERE x.tenant_id = p.tenant_id
        AND x.product_id = p.id AND x.deleted_at IS NULL
        AND x.normalized_number ILIKE ANY(${codes}::text[]))`,
    ]
    if (!oemOnly) predicates.push(
      `p.name ILIKE ANY(${patterns}::text[])`,
      `p.sku ILIKE ANY(${patterns}::text[])`,
      `p.sku ILIKE ANY(${codes}::text[])`,
      `p.barcode ILIKE ANY(${patterns}::text[])`,
      `COALESCE(p.additional_barcodes, '[]'::jsonb) ? ${exact}`,
      `EXISTS (SELECT 1 FROM product_aliases a WHERE a.tenant_id = p.tenant_id
        AND a.product_id = p.id AND a.deleted_at IS NULL AND a.alias ILIKE ANY(${patterns}::text[]))`,
      `EXISTS (SELECT 1 FROM product_supplier_codes s WHERE s.tenant_id = p.tenant_id
        AND s.product_id = p.id AND (s.supplier_code ILIKE ANY(${codes}::text[])
          OR s.normalized_supplier_article ILIKE ANY(${codes}::text[])))`,
      `EXISTS (SELECT 1 FROM product_barcodes b WHERE b.tenant_id = p.tenant_id
        AND b.product_id = p.id AND b.deleted_at IS NULL AND b.barcode ILIKE ANY(${patterns}::text[]))`,
    )
    where.push(`(${predicates.join(' OR ')})`)
    exactOrder = `CASE WHEN e.sku IN (${exact}, ${compact}) OR e.barcode IN (${exact}, ${compact}) THEN 0 ELSE 1 END`
  }

  const sortColumns = {
    sku: 'e.sku', name: 'e.name', retail_price: 'e.retail_price',
    qty_on_hand: 'e.qty_available', created_at: 'e.created_at', brand: 'e._brand_name',
  }
  const field = filters.sort_field
  const order = ['CASE WHEN e.qty_available > 0 OR e.is_service THEN 0 ELSE 1 END']
  if (exactOrder) order.push(exactOrder)
  if (field && sortColumns[field]) order.push(`${sortColumns[field]} ${filters.sort_dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`)
  else order.push('e.is_favorite DESC NULLS LAST')
  if (field !== 'name') order.push('e.name ASC')
  order.push('e.id ASC')
  const pageSize = Math.max(1, Math.min(2000, Math.trunc(filters.per_page)))
  const offset = (Math.max(1, Math.trunc(filters.page)) - 1) * pageSize
  const limitParam = bind(pageSize)
  const offsetParam = bind(offset)

  return {
    values,
    text: `WITH matched AS MATERIALIZED (
      SELECT p.*, br.name AS _brand_name,
        CASE WHEN br.id IS NULL THEN NULL ELSE jsonb_build_object('id', br.id, 'name', br.name) END AS brand,
        CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id', c.id, 'name', c.name) END AS category
      FROM products p
      LEFT JOIN brands br ON br.id = p.brand_id AND br.tenant_id = p.tenant_id AND br.deleted_at IS NULL
      LEFT JOIN categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id AND c.deleted_at IS NULL
      WHERE ${where.join(' AND ')}
    ), active_reserves AS (
      SELECT r.product_id, SUM(r.qty) AS qty_reserved FROM inventory_reserves r
      WHERE r.tenant_id = $1 AND r.released_at IS NULL
        AND (r.expires_at IS NULL OR r.expires_at > now())
      GROUP BY r.product_id
    ), enriched AS (
      SELECT m.*, COALESCE(r.qty_reserved, 0) AS qty_reserved,
        m.qty_on_hand - COALESCE(r.qty_reserved, 0) AS qty_available
      FROM matched m LEFT JOIN active_reserves r ON r.product_id = m.id
    ), paged AS (
      SELECT e.*, row_number() OVER (ORDER BY ${order.join(', ')}) AS _position
      FROM enriched e ORDER BY ${order.join(', ')} LIMIT ${limitParam} OFFSET ${offsetParam}
    )
    SELECT (SELECT count(*)::integer FROM matched) AS total,
      COALESCE(jsonb_agg(to_jsonb(paged) - '_position' - '_brand_name' ORDER BY _position), '[]'::jsonb) AS data
    FROM paged`,
  }
}
