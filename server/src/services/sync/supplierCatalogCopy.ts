import { pool } from '../../db/pg.js'
import { AppError } from '../../middleware/errorHandler.js'
import { createSupplierCatalogManifest } from '../../lib/supplierCatalogManifest.js'

// One SELECT has one MVCC snapshot; never split these into REST pages.
// Full/reference copies include tombstones and repair timestamp cursor gaps.
// Delta scope is explicit; missing IDs never instruct deletion of local data.
export const SUPPLIER_CATALOG_COPY_SQL = `
  WITH items AS MATERIALIZED (
    SELECT id,tenant_id,supplier_id,sku,barcode,brand,name,price_kopecks,
      qty::text AS qty,warehouse_name,created_at,updated_at,deleted_at
    FROM public.supplier_price_items WHERE tenant_id=$1::uuid
      AND ($2::timestamptz IS NULL OR updated_at > $2::timestamptz)
  ), imports AS MATERIALIZED (
    SELECT id,tenant_id,supplier_id,filename,mode,warehouse_name,status,
      total_rows,processed_rows,errors_log,created_at,updated_at
    FROM public.supplier_price_imports WHERE tenant_id=$1::uuid
      AND ($2::timestamptz IS NULL OR updated_at > $2::timestamptz)
  ), supplier_refs AS MATERIALIZED (
    SELECT supplier_id AS id FROM items WHERE supplier_id IS NOT NULL
    UNION SELECT supplier_id FROM imports WHERE supplier_id IS NOT NULL
  ), parents AS MATERIALIZED (
    SELECT id,tenant_id,name,phone,email,contact_name,notes,is_active,created_at,updated_at,deleted_at
    FROM public.suppliers WHERE tenant_id=$1::uuid AND id IN (SELECT id FROM supplier_refs)
  )
  SELECT
    COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM items i),'[]'::jsonb) AS items,
    COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM imports i),'[]'::jsonb) AS imports,
    (SELECT count(*)::text FROM items) AS item_count,
    (SELECT count(*)::text FROM imports) AS import_count,
    COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM parents p),'[]'::jsonb) AS parents,
    (SELECT count(*)::text FROM supplier_refs) AS required_supplier_count
`
/** Dependency repair only; preserve the snapshot's archived state, never reactivate it. */
export function mergeCatalogSupplierParents(suppliers: any[], parents: any[]): any[] {
  const merged = new Map(suppliers.map(row => [row.id,row]))
  for (const row of parents) merged.set(row.id,row)
  return [...merged.values()]
}

export async function fetchSupplierCatalogCopy(tenantId: string, cursor: string, role: string, since?: string) {
  if (role !== 'owner' && role !== 'admin') return {
    // Explicit empty scope is verifiable without reading or exposing restricted prices.
    data: { supplier_price_items: [], supplier_price_imports: [],
      supplier_catalog_copy: createSupplierCatalogManifest(tenantId, cursor, [], [], since ?? null) }, parents: [] as any[],
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)
    || !Number.isFinite(Date.parse(cursor))
    || (since !== undefined && (!Number.isFinite(Date.parse(since)) || Date.parse(since) > Date.parse(cursor)))) throw new AppError('SYNC_CATALOG_SCOPE_INVALID', 'Некоректні реквізити копії прайсу.', 400)
  const result = await pool.query(SUPPLIER_CATALOG_COPY_SQL, [tenantId, since ?? null])
  const row = result.rows[0]
  if (result.rows.length !== 1 || !row || !Array.isArray(row.items) || !Array.isArray(row.imports)
    || row.item_count !== String(row.items.length) || row.import_count !== String(row.imports.length)
    || !Array.isArray(row.parents) || row.required_supplier_count !== String(row.parents.length)) {
    throw new AppError('SYNC_CATALOG_COPY_INCOMPLETE', 'Не вдалося отримати повну копію прайсу. Повторіть синхронізацію.', 503)
  }
  const required = new Set<string>([...row.items,...row.imports].map(r => r.supplier_id).filter(id => id != null))
  for (const parent of row.parents) {
    if (!parent || parent.tenant_id !== tenantId || !required.delete(parent.id))
      throw new AppError('SYNC_CATALOG_COPY_INCOMPLETE', 'Некоректні постачальники у копії прайсу.', 503)
  }
  if (required.size) throw new AppError('SYNC_CATALOG_COPY_INCOMPLETE', 'У копії прайсу відсутній постачальник.', 503)
  return { parents: row.parents as any[], data: {
    supplier_price_items: row.items,
    supplier_price_imports: row.imports,
    supplier_catalog_copy: createSupplierCatalogManifest(tenantId, cursor, row.items, row.imports, since ?? null),
  } }
}
