import { describe, expect, it } from 'vitest'
import { catalogCleanupManifestBlockers } from '../src/repositories/catalogCleanupManifest'
const tenant = '00000000-0000-0000-0000-000000000001', target = '00000000-0000-4000-8000-000000000001', source = '00000000-0000-4000-8000-000000000002'
const at = '2026-10-13T10:00:00.000Z', id = (n: number) => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0')
function fixture() {
  const products = [target, source].map((productId, index) => ({ id: productId, tenant_id: tenant, sku: 'SKU-' + index, name: 'Фільтр', barcode: null, brand_id: null,
    specs_json: '{}', qty_on_hand: 1, is_active: 1, deleted_at: null, created_at: at, updated_at: at }))
  const metadata: { product_barcodes: Record<string, any>[]; product_aliases: Record<string, any>[]; product_cross_numbers: Record<string, any>[] } = { product_barcodes: [], product_aliases: [], product_cross_numbers: [] }
  return { products, metadata, check: () => catalogCleanupManifestBlockers({ tenant_id: tenant, target_id: target, source_ids: [source], stock_review: 'pending' }, products, metadata, [], 2) }
}
const common = { id: id(3), tenant_id: tenant, product_id: source, created_at: at, updated_at: at, deleted_at: null }
describe('cleanup manifest preflight boundaries (no database)', () => {
  it('allows the exact name/article/alias limits and rejects an excess without trimming', () => {
    const f = fixture(); f.products[0].name = 'A'.repeat(1000); f.products[0].sku = 'S'.repeat(100); f.products[1].name = 'B'.repeat(300)
    expect(f.check()).toEqual([])
    f.products[0].name += 'A'; f.products[0].sku += 'S'; f.products[1].name += 'B'
    expect(f.check().join(' ')).toMatch(/1000/); expect(f.check().join(' ')).toMatch(/100/); expect(f.check().join(' ')).toMatch(/300/)
  })
  it.each(['barcode', 'type', 'alias', 'cross', 'cross-brand', 'cross-source', 'date', 'uuid'])('rejects incompatible %s metadata', kind => {
    const f = fixture()
    if (kind === 'barcode' || kind === 'type') f.metadata.product_barcodes.push({ ...common, barcode: kind === 'barcode' ? '1'.repeat(101) : '123', barcode_type: kind === 'type' ? 'T'.repeat(21) : 'EAN13', is_primary: 0 })
    if (kind === 'alias') f.metadata.product_aliases.push({ ...common, alias: 'A'.repeat(301) })
    if (kind.startsWith('cross')) f.metadata.product_cross_numbers.push({ ...common, cross_number: kind === 'cross' ? 'A'.repeat(101) : 'OE123', brand: kind === 'cross-brand' ? 'B'.repeat(101) : null, source: kind === 'cross-source' ? 'S'.repeat(201) : '' })
    if (kind === 'date' || kind === 'uuid') f.metadata.product_aliases.push({ ...common, alias: 'Old', ...(kind === 'date' ? { deleted_at: 'bad' } : { id: 'legacy' }) })
    expect(f.check().length).toBeGreaterThan(0)
  })
  it('counts generated aliases as part of the 5000-row protocol limit', () => {
    const f = fixture()
    f.metadata.product_aliases = Array.from({ length: 4998 }, (_, index) => ({ ...common, id: id(index + 10), product_id: target, alias: 'Old alias ' + index }))
    expect(f.check().filter(message => /5000/.test(message))).toEqual([])
    f.metadata.product_aliases.push({ ...common, id: id(9999), product_id: target, alias: 'Another old alias' })
    expect(f.check().join(' ')).toMatch(/5000/)
  })
  it('does not silently shorten an invalid historical barcode list', () => {
    const f = fixture(); f.products[1].specs_json = JSON.stringify({ cleanup_barcodes: ['Z'.repeat(101)] })
    expect(f.check().join(' ')).toMatch(/історія штрихкодів/)
  })
})
