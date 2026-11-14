import { isDeepStrictEqual } from 'node:util'
import { catalogPriceKopecks, catalogQuantity } from './supplierCatalogNumbers.js'

/** Validate the destination before opening either database; never echo its URL. */
export function assertSupplierCatalogAuditConnection(connection: unknown, project: unknown): asserts connection is string {
  if (typeof connection !== 'string' || !connection || typeof project !== 'string' || !/^[a-z]{20}$/.test(project))
    throw new Error('Explicit database connection and expected project are required')
  let url: URL
  try { url = new URL(connection) } catch { throw new Error('Invalid database connection URL') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !(url.hostname === 'db.' + project + '.supabase.co'
      || url.hostname.endsWith('.pooler.supabase.com') && decodeURIComponent(url.username) === 'postgres.' + project)
    || [...url.searchParams.keys()].some(key => key !== 'sslmode'))
    throw new Error('Database connection does not match the explicitly requested project')
}

export type CatalogTable = 'supplier_price_items' | 'supplier_price_imports'
type Row = Record<string, unknown>
type Side = 'local' | 'server'
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const invalid = (): never => { throw new Error('Invalid catalog audit input') }
const text = (value: unknown, nullable = false): string | null => {
  if (nullable && value === null) return null
  return typeof value === 'string' && (nullable || value.trim()) ? value : invalid()
}
const count = (value: unknown): number => typeof value === 'number'
  && Number.isInteger(value) && value >= 0 && value <= 2147483647 ? value : invalid()

// Compare instants without losing PostgreSQL microseconds. Ambiguous local-time
// strings and impossible calendar dates are errors, never silently normalized.
function timestamp(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null
  if (value instanceof Date) value = value.toISOString()
  if (typeof value !== 'string') return invalid()
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!m) return invalid()
  const [,year,month,day,hour,minute,second,fraction = '',zone] = m
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`)
  const ms = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`)
  if (!Number.isFinite(ms) || date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return invalid()
  return (BigInt(ms) * 1000000n + BigInt(fraction.padEnd(9, '0'))).toString()
}

function normalized(table: CatalogTable, row: Row, side: Side): Row {
  if (!uuid(row.id) || !uuid(row.tenant_id)
    || row.supplier_id !== null && !uuid(row.supplier_id)) return invalid()
  const base: Row = { id: row.id.toLowerCase(), tenant_id: row.tenant_id.toLowerCase(),
    supplier_id: typeof row.supplier_id === 'string' ? row.supplier_id.toLowerCase() : null,
    warehouse_name: text(row.warehouse_name, true),
    created_at: timestamp(row.created_at), deleted_at: timestamp(row.deleted_at, true) }
  if (table === 'supplier_price_items') {
    if (row.qty === undefined) return invalid()
    return { ...base, sku: text(row.sku), name: text(row.name), barcode: text(row.barcode, true),
      brand: text(row.brand, true), price_kopecks: catalogPriceKopecks(row.price_kopecks),
      qty: catalogQuantity(row.qty) }
  }
  if (side === 'local' && row.scope_known !== 0 && row.scope_known !== 1) return invalid()
  const mode = side === 'local' && row.scope_known === 0 ? null : row.mode
  if (mode !== null && mode !== 'add' && mode !== 'replace'
    || !['pending','processing','completed','failed'].includes(String(row.status))) return invalid()
  const total = count(row.total_rows), processed = count(row.processed_rows)
  if (processed > total) return invalid()
  const errors = side === 'local' ? JSON.parse(String(row.errors_json)) : row.errors_log
  if (!Array.isArray(errors) || errors.some(e => !e || typeof e !== 'object' || Array.isArray(e)
    || !Number.isSafeInteger(e.row) || e.row < 0 || typeof e.error !== 'string'
    || e.raw !== undefined && typeof e.raw !== 'string'
    || Object.keys(e).some(k => !['row','error','raw'].includes(k)))) return invalid()
  return { ...base, mode, filename: text(row.filename), status: row.status,
    total_rows: total, processed_rows: processed, errors_log: errors }
}

/** Diagnostic only. Even a date-only difference is NOT permission to rewrite
 * or merge. No names, prices, barcodes or row IDs are returned in the report. */
export function compareSupplierCatalog(table: CatalogTable, tenant: string, local: Row[], server: Row[]) {
  if (!uuid(tenant) || local.length > 100000 || server.length > 100000) return invalid()
  const report = { table, local: local.length, server: server.length, compared: 0, equal: 0,
    onlyLocal: 0, onlyServer: 0, dateOnlyDifferences: 0, businessDifferences: 0,
    invalidLocal: 0, invalidServer: 0, duplicateLocalIds: 0, duplicateServerIds: 0,
    unfinishedLocalImports: 0, unfinishedServerImports: 0, fields: {} as Record<string, number>,
    catalogsEqual: false }
  function index(rows: Row[], side: Side): Map<string, Row> {
    const result = new Map<string, Row>(), seen = new Set<string>()
    for (const row of rows) {
      try {
        const value = normalized(table, row, side)
        if (value.tenant_id !== tenant.toLowerCase()) return invalid()
        const id = String(value.id)
        if (seen.has(id)) {
          report[side === 'local' ? 'duplicateLocalIds' : 'duplicateServerIds']++
          result.delete(id)
          continue
        }
        seen.add(id); result.set(id, value)
        if (table === 'supplier_price_imports' && ['pending','processing'].includes(String(value.status)))
          report[side === 'local' ? 'unfinishedLocalImports' : 'unfinishedServerImports']++
      } catch {
        report[side === 'local' ? 'invalidLocal' : 'invalidServer']++
      }
    }
    return result
  }
  const left = index(local, 'local'), right = index(server, 'server')
  for (const [id, a] of left) {
    const b = right.get(id)
    if (!b) { report.onlyLocal++; continue }
    report.compared++
    const fields = Object.keys(a).filter(key => !isDeepStrictEqual(a[key], b[key]))
    if (!fields.length) { report.equal++; continue }
    for (const field of fields) report.fields[field] = (report.fields[field] ?? 0) + 1
    if (fields.every(key => key === 'created_at' || key === 'deleted_at')) report.dateOnlyDifferences++
    else report.businessDifferences++
  }
  report.onlyServer = [...right.keys()].filter(id => !left.has(id)).length
  report.catalogsEqual = report.equal === local.length && report.equal === server.length
    && !report.invalidLocal && !report.invalidServer && !report.duplicateLocalIds && !report.duplicateServerIds
  return report
}
