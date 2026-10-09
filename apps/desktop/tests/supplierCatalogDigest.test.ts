import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { createSupplierCatalogManifest, validateSupplierCatalogManifest } from '../src/lib/supplierCatalogManifest'

const tenant = 'shop', cursor = '2026-10-09T10:00:00.123456Z'
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
function oldDigest(manifest: any, items: any[], imports: any[]) {
  const { sha256: _, ...scope } = manifest
  return createHash('sha256').update(JSON.stringify(canonical({ ...scope, items, imports }))).digest('hex')
}
it.each([0, 1, 100, 15000])('keeps v1 hash for %s rows without a full canonical catalog copy', n => {
  const items = Array.from({ length: n }, (_, i) => ({ id: 'i' + i, tenant_id: tenant,
    name: 'Олива 🛢️ \\"\\n' + i, qty: '0.125', price_kopecks: 12345,
    nested: { '10': 'ten', '2': 'two', z: [null, true, -0, 1e-7, { b: '𐀀', a: '\ud800' }], a: 'last' } }))
  const imports = [{ id: 'history', tenant_id: tenant, errors_log: [{ row: 4, detail: 'Перевірте' }] }]
  const manifest = createSupplierCatalogManifest(tenant, cursor, items, imports)
  expect(manifest.sha256).toBe(oldDigest(manifest, items, imports))
  const copy = JSON.parse(JSON.stringify({ supplier_price_items: items, supplier_price_imports: imports, supplier_catalog_copy: manifest }))
  expect(() => validateSupplierCatalogManifest(copy, tenant, cursor)).not.toThrow()
})
it.each([null, '2026-10-01T00:00:00Z'])('keeps full and delta hashes including scope %s', since => {
  const items = [{ id: 'i', tenant_id: tenant, extra: JSON.parse('{"__proto__":{"secret":false},"constructor":7}') }]
  const manifest = createSupplierCatalogManifest(tenant, cursor, items, [], since)
  expect(manifest.sha256).toBe(oldDigest(manifest, items, []))
})
it.each([undefined, NaN, Infinity, BigInt(2), () => 1, Symbol('bad')])('still rejects non-JSON row fields %s', bad => {
  expect(() => createSupplierCatalogManifest(tenant, cursor, [{ id: 'i', tenant_id: tenant, bad }], [])).toThrow()
})
it('does not modify frozen input arrays, objects or metadata', () => {
  const items = Object.freeze([Object.freeze({ id: 'i', tenant_id: tenant, name: 'Товар' })])
  const imports = Object.freeze([])
  expect(() => createSupplierCatalogManifest(tenant, cursor, items, imports)).not.toThrow()
})
