export interface SaleHistoryFilters {
  product_search?: string; product_id?: string; product_barcode?: string; seller_id?: string; unit_price?: number
  include_returns?: string; date_from?: string; date_to?: string; date_to_exclusive?: string
}

// Live barcode rows move to the canonical card during cleanup. Only the source's
// preserved codes belong to its historical receipts; do not borrow target codes.
const sourceBarcodeHistory = `CASE WHEN json_valid(p.specs_json) THEN CASE
  WHEN json_type(p.specs_json,'$.cleanup_barcodes')='array'
    AND json_type(p.specs_json,'$.merged_into_product_id')='text'
    AND length(trim(json_extract(p.specs_json,'$.merged_into_product_id')))>0
  THEN json_extract(p.specs_json,'$.cleanup_barcodes') ELSE '[]' END ELSE '[]' END`

export function productHistoryTextMatch(line: string, query: string, params: unknown[]) {
  const tokens = query.trim().toLocaleLowerCase('uk-UA').split(/\s+/).filter(Boolean)
  return tokens.map(token => {
    params.push(token)
    return `instr(forsage_lower(COALESCE(${line}.description,'') || ' ' || COALESCE(${line}.sku,'') || ' ' ||
      COALESCE(p.name,'') || ' ' || COALESCE(p.sku,'') || ' ' || COALESCE(p.barcode,'') || ' ' ||
      COALESCE((SELECT group_concat(pb.barcode,' ') FROM product_barcodes pb WHERE pb.product_id=${line}.product_id AND pb.tenant_id=s.tenant_id AND pb.deleted_at IS NULL),'') || ' ' ||
      COALESCE((SELECT group_concat(hb.value,' ') FROM json_each(${sourceBarcodeHistory}) hb WHERE hb.type='text'),'')), ?) > 0`
  }).join(' AND ') || '1=1'
}

/** Bound parameters only; product snapshots remain searchable after rename/archive. */
export function saleHistoryFilters(input: SaleHistoryFilters, params: unknown[]): string[] {
  const result: string[] = []
  const barcode = String(input.product_barcode ?? '').trim()
  const match = (line: string) => {
    const conditions = [`${line}.tenant_id = s.tenant_id`, `${line}.deleted_at IS NULL`]
    if (input.product_id) { conditions.push(`${line}.product_id = ?`); params.push(input.product_id) }
    if (input.unit_price !== undefined) {
      if (!Number.isSafeInteger(Number(input.unit_price)) || Number(input.unit_price) < 0) throw new Error('Некоректна ціна товару в чеку')
      conditions.push(`${line}.unit_price = ?`); params.push(Number(input.unit_price))
    }
    if (input.product_search?.trim()) conditions.push(productHistoryTextMatch(line, input.product_search, params))
    if (barcode) {
      conditions.push(`(p.barcode = ? OR p.sku = ? OR ${line}.sku = ? OR EXISTS (
        SELECT 1 FROM product_barcodes pb WHERE pb.product_id=${line}.product_id
          AND pb.tenant_id=s.tenant_id AND pb.deleted_at IS NULL AND pb.barcode = ?)
        OR EXISTS(SELECT 1 FROM json_each(${sourceBarcodeHistory}) hb WHERE hb.type='text' AND hb.value = ?))`)
      params.push(barcode, barcode, barcode, barcode, barcode)
    }
    return conditions.join(' AND ')
  }
  const hasProduct = !!(input.product_id || input.product_search?.trim() || barcode || input.unit_price !== undefined)
  if (hasProduct) result.push(`EXISTS (SELECT 1 FROM sale_items si LEFT JOIN products p ON p.id=si.product_id AND p.tenant_id=si.tenant_id WHERE si.sale_id=s.id AND ${match('si')})`)
  if (input.seller_id) {
    result.push(`COALESCE(NULLIF(s.manager_id,''),(SELECT NULLIF(o.manager_id,'') FROM customer_orders o WHERE o.sale_id=s.id AND o.tenant_id=s.tenant_id AND o.deleted_at IS NULL ORDER BY o.id LIMIT 1),NULLIF(s.cashier_id,''),'__unknown__') = ?`)
    params.push(input.seller_id)
  }
  const range = (field: string) => {
    if (input.date_from && input.date_to && Date.parse(input.date_from) > Date.parse(input.date_to)) throw new Error('Некоректний період продажів')
    if (input.date_to && input.date_to_exclusive) throw new Error('Вкажіть лише одну кінцеву межу періоду продажів')
    if (input.date_from && input.date_to_exclusive && Date.parse(input.date_from) >= Date.parse(input.date_to_exclusive)) throw new Error('Некоректний період продажів')
    const bounds = []
    for (const [value, operator] of [[input.date_from, '>='], [input.date_to, '<='], [input.date_to_exclusive, '<']] as const) {
      if (!value) continue
      if (!Number.isFinite(Date.parse(value))) throw new Error('Некоректний період продажів')
      bounds.push(`julianday(${field}) ${operator} julianday(?)`); params.push(value)
    }
    return bounds.join(' AND ') || '1=1'
  }
  if (input.date_from || input.date_to || input.date_to_exclusive) {
    const saleRange = range('COALESCE(s.completed_at,s.created_at)')
    if (input.include_returns === '1') {
      const returnRange = range('r.created_at')
      const returnedProduct = hasProduct ? ` AND EXISTS (SELECT 1 FROM customer_return_items ri JOIN sale_items rsi ON rsi.id=ri.sale_item_id AND rsi.tenant_id=ri.tenant_id LEFT JOIN products p ON p.id=rsi.product_id AND p.tenant_id=rsi.tenant_id WHERE ri.return_id=r.id AND ri.tenant_id=s.tenant_id AND ri.deleted_at IS NULL AND ${match('rsi')})` : ''
      result.push(`((${saleRange}) OR EXISTS (SELECT 1 FROM customer_returns r WHERE r.sale_id=s.id AND r.tenant_id=s.tenant_id AND r.deleted_at IS NULL AND r.status='completed' AND ${returnRange}${returnedProduct}))`)
    } else result.push(saleRange)
  }
  if (input.include_returns === '1') result.push("s.status IN ('completed','returned')")
  return result
}
