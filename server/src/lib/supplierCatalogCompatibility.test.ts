import { describe, expect, it } from 'vitest'
import { assertSupplierCatalogAuditConnection, compareSupplierCatalog } from './supplierCatalogCompatibility.js'

const tenant = '00000000-0000-0000-0000-000000000001'
const id = '10000000-0000-4000-8000-000000000001'
const supplier = '20000000-0000-4000-8000-000000000001'
const at = '2026-10-10T12:00:00.000Z'
const item = (overrides: Record<string, unknown> = {}) => ({
  id, tenant_id: tenant, supplier_id: supplier, warehouse_name: null,
  created_at: at, deleted_at: null, sku: 'PRIVATE-SKU', name: 'PRIVATE-NAME',
  barcode: 'PRIVATE-BARCODE', brand: null, price_kopecks: 12345, qty: '2.125', ...overrides,
})
const history = (overrides: Record<string, unknown> = {}) => ({
  id, tenant_id: tenant, supplier_id: supplier, warehouse_name: null,
  created_at: at, deleted_at: null, filename: 'private.xlsx', mode: 'add', scope_known: 1,
  status: 'completed', total_rows: 2, processed_rows: 2, errors_json: '[]', errors_log: [], ...overrides,
})
const compare = (a: Record<string, unknown>[], b: Record<string, unknown>[]) =>
  compareSupplierCatalog('supplier_price_items', tenant, a, b)

describe('read-only supplier catalog compatibility report', () => {
  const project = 'zuhanlspejgizjbwbnda'
  it.each([
    'postgresql://postgres:private@db.' + project + '.supabase.co/postgres?sslmode=require',
    'postgresql://postgres.' + project + ':private@aws-0-eu-central-1.pooler.supabase.com:6543/postgres',
  ])('allows the explicit direct or pooler destination', connection => {
    expect(() => assertSupplierCatalogAuditConnection(connection,project)).not.toThrow()
  })
  it.each([
    'postgresql://postgres:DO-NOT-LOG@example.com/postgres',
    'postgresql://postgres.otherproject:DO-NOT-LOG@aws-0-eu-central-1.pooler.supabase.com/postgres',
    'postgresql://postgres.' + project + ':DO-NOT-LOG@aws-0-eu-central-1.pooler.supabase.com/postgres?host=other',
    'DO-NOT-LOG', '', undefined,
  ])('rejects unsafe configuration without exposing its secret', connection => {
    let caught: unknown
    try { assertSupplierCatalogAuditConnection(connection,project) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(Error)
    expect(String(caught)).not.toContain('DO-NOT-LOG')
  })
  it('compares business contents, not upload time or local bookkeeping', () => {
    const a = item({ updated_at: at, dirty_at: at }), b = item({ updated_at: '2026-10-11T12:00:00Z' })
    const before = structuredClone([a,b])
    expect(compare([a],[b])).toMatchObject({ catalogsEqual: true, compared: 1, equal: 1 })
    expect([a,b]).toEqual(before)
  })
  it('accepts the known original tenant ID and exact numeric representations', () => {
    expect(compare([item()],[item({ qty: 2.125, price_kopecks: '12345' })]).catalogsEqual).toBe(true)
  })
  it('compares equivalent time zones and fractional representations', () => {
    expect(compare([item()],[item({ created_at: '2026-10-10T15:00:00.000000+03:00' })]).catalogsEqual).toBe(true)
  })
  it('preserves microsecond differences instead of truncating them', () => {
    expect(compare([item()],[item({ created_at: '2026-10-10T12:00:00.000001Z' })]))
      .toMatchObject({ dateOnlyDifferences: 1, businessDifferences: 0, catalogsEqual: false, fields: { created_at: 1 } })
  })
  it('classifies a deletion date difference without approving repair', () => {
    const r = compare([item({ deleted_at: at })],[item({ deleted_at: '2026-10-11T12:00:00Z' })])
    expect(r).toMatchObject({ dateOnlyDifferences: 1, catalogsEqual: false })
    expect(r).not.toHaveProperty('repair')
  })
  it.each(['supplier_id','sku','barcode','brand','name','price_kopecks','qty','warehouse_name'])(
    'does not hide a business difference in %s as a harmless date difference', field => {
      const value = field === 'supplier_id' ? null : field === 'price_kopecks' ? 12000 : field === 'qty' ? '3' : 'changed'
      expect(compare([item()],[item({ [field]: value, created_at: '2026-10-11T12:00:00Z' })]))
        .toMatchObject({ dateOnlyDifferences: 0, businessDifferences: 1, catalogsEqual: false })
    })
  it('separates missing local and missing server records, including tombstones', () => {
    expect(compare([item({ id: supplier, deleted_at: at })],[item()]))
      .toMatchObject({ onlyLocal: 1, onlyServer: 1, compared: 0, catalogsEqual: false })
  })
  it('does not include product names, identifiers or prices in a report', () => {
    const serialized = JSON.stringify(compare([item()],[item({ price_kopecks: 9 })]))
    for (const secret of [id, supplier, 'PRIVATE-NAME','PRIVATE-SKU','PRIVATE-BARCODE','12345']) expect(serialized).not.toContain(secret)
  })
  it.each(['2026-02-30T12:00:00Z','2026-10-10','2026-10-10T12:00:00','2026-10-10T24:00:00Z','2026-10-10T12:60:00Z','2026-10-10T12:00:00+25:00'])(
    'marks an invalid source date as uncomparable: %s', created_at => {
      expect(compare([item({ created_at })],[item()])).toMatchObject({ invalidLocal: 1, catalogsEqual: false })
    })
  it.each([{ qty: undefined },{ qty: -1 },{ price_kopecks: 1.5 },{ tenant_id: supplier },{ supplier_id: 'bad' },{ id: '' },{ name: '' }])(
    'rejects malformed or foreign records: %j', invalid => {
      expect(compare([item()],[item(invalid)])).toMatchObject({ invalidServer: 1, catalogsEqual: false })
    })
  it('does not match one of several records with a duplicate ID', () => {
    expect(compare([item(),item(),item()],[item(),item()]))
      .toMatchObject({ duplicateLocalIds: 2, duplicateServerIds: 1, compared: 0, catalogsEqual: false })
  })
  it('handles empty catalogs without inventing missing records', () => {
    expect(compare([],[])).toMatchObject({ catalogsEqual: true, equal: 0 })
  })
  it('bounds rows and requires a tenant', () => {
    expect(() => compare(new Array(100001).fill(item()),[])).toThrow()
    expect(() => compareSupplierCatalog('supplier_price_items','',[],[])).toThrow()
  })
  it('compares import history without trusting its presentation order', () => {
    const errors = [{ row: 2, error: 'test', raw: 'private data' }]
    expect(compareSupplierCatalog('supplier_price_imports',tenant,
      [history({ errors_json: JSON.stringify(errors) })],
      [history({ errors_log: [{raw:'private data',error:'test',row:2}] })])).toMatchObject({ catalogsEqual: true })
  })
  it('preserves unknown historical import scope rather than assuming add', () => {
    expect(compareSupplierCatalog('supplier_price_imports',tenant,
      [history({ scope_known: 0 })],[history({ mode: null })])).toMatchObject({ catalogsEqual: true })
    expect(compareSupplierCatalog('supplier_price_imports',tenant,
      [history({ scope_known: 0 })],[history()])).toMatchObject({ businessDifferences: 1, fields: {mode: 1} })
  })
  it.each([{ errors_json:'bad' },{ scope_known:2 },{ processed_rows:3 },{ status:'unknown' },{ total_rows:-1 }])(
    'reports invalid import contents: %j', invalid => {
      expect(compareSupplierCatalog('supplier_price_imports',tenant,[history(invalid)],[history()]))
        .toMatchObject({ invalidLocal: 1, catalogsEqual: false })
    })
  it('flags unfinished imports even when the two copies match', () => {
    expect(compareSupplierCatalog('supplier_price_imports',tenant,
      [history({ status:'processing' })],[history({ status:'processing' })]))
      .toMatchObject({ unfinishedLocalImports: 1, unfinishedServerImports: 1, catalogsEqual: true })
  })
})
