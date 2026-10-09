import { createHash } from 'node:crypto'

export type SupplierCatalogManifest = {
  version: 1
  mode: 'full' | 'delta'
  since: string | null
  tenant_id: string
  cursor: string
  item_count: number
  import_count: number
  sha256: string
}
type Copy = {
  supplier_price_items?: unknown
  supplier_price_imports?: unknown
  supplier_catalog_copy?: unknown
}
const invalid = () => new Error('Неповна або пошкоджена копія прайсу. Дані не застосовано; повторіть синхронізацію.')
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

// The protocol is JSON-only; key order does not change its content fingerprint.
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical)
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => {
    if (value[key] === undefined) throw invalid()
    return [key, canonical(value[key])]
  }))
  if (value !== null && typeof value !== 'string' && typeof value !== 'boolean'
    && (typeof value !== 'number' || !Number.isFinite(value))) throw invalid()
  return value
}
function rows(value: unknown, tenantId: string): any[] {
  if (!Array.isArray(value)) throw invalid()
  const ids = new Set<string>()
  for (const row of value) {
    if (!object(row) || typeof row.id !== 'string' || !row.id.trim()
      || row.tenant_id !== tenantId || ids.has(row.id)) throw invalid()
    ids.add(row.id)
  }
  return value
}
function digest(scope: Omit<SupplierCatalogManifest, 'sha256'>, items: any[], imports: any[]): string {
  // Keep the v1 byte sequence exactly, but do not clone and stringify the entire
  // catalog at once. Only one canonical row is retained in addition to the input.
  const hash = createHash('sha256')
  const payload: Record<string, unknown> = { ...scope, items, imports }
  hash.update('{')
  let first = true
  for (const key of Object.keys(payload).sort()) {
    hash.update((first ? '' : ',') + JSON.stringify(key) + ':')
    first = false
    const value = payload[key]
    if (Array.isArray(value)) {
      hash.update('[')
      for (let index = 0; index < value.length; index++) {
        if (index) hash.update(',')
        hash.update(JSON.stringify(canonical(value[index])))
      }
      hash.update(']')
    } else {
      hash.update(JSON.stringify(canonical(value)))
    }
  }
  return hash.update('}').digest('hex')
}
export function createSupplierCatalogManifest(
  tenantId: string, cursor: string, items: unknown, imports: unknown, since: string | null = null,
): SupplierCatalogManifest {
  if (!tenantId || !cursor || !Number.isFinite(Date.parse(cursor))
    || (since !== null && (typeof since !== 'string' || !Number.isFinite(Date.parse(since))
      || Date.parse(since) > Date.parse(cursor)))) throw invalid()
  const checkedItems = rows(items, tenantId), checkedImports = rows(imports, tenantId)
  const scope = { version: 1 as const, mode: since === null ? 'full' as const : 'delta' as const,
    since, tenant_id: tenantId, cursor,
    item_count: checkedItems.length, import_count: checkedImports.length }
  return { ...scope, sha256: digest(scope, checkedItems, checkedImports) }
}
/** Legacy responses remain compatible, but only a present valid manifest proves
 * the received catalog's completeness. This is integrity, not authentication. */
export function validateSupplierCatalogManifest(copy: Copy, tenantId: string, cursor: string): void {
  if (copy.supplier_catalog_copy === undefined) return
  const manifest = copy.supplier_catalog_copy
  if (!object(manifest) || manifest.version !== 1
    || !['full','delta'].includes(manifest.mode)
    || (manifest.mode === 'full' ? manifest.since !== null : typeof manifest.since !== 'string')
    || manifest.tenant_id !== tenantId || manifest.cursor !== cursor
    || !Number.isSafeInteger(manifest.item_count) || manifest.item_count < 0
    || !Number.isSafeInteger(manifest.import_count) || manifest.import_count < 0
    || typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw invalid()
  const expected = createSupplierCatalogManifest(tenantId, cursor,
    copy.supplier_price_items, copy.supplier_price_imports, manifest.since)
  if (manifest.item_count !== expected.item_count || manifest.import_count !== expected.import_count
    || manifest.sha256 !== expected.sha256) throw invalid()
}
