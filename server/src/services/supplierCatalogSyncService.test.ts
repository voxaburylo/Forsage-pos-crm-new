import { beforeAll, describe, expect, it } from 'vitest'

let validateSupplierCatalogIdentityRows: (rows: any[]) => void

beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgres://localhost/forsage-test'
  ;({ validateSupplierCatalogIdentityRows } = await import('./supplierCatalogSyncService.js'))
})

const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'

describe('supplier catalog sync identity guard', () => {
  it('allows different product variants', () => {
    expect(() => validateSupplierCatalogIdentityRows([
      { id: firstId, sku: 'RUL-5', name: 'Рулетка 5м Greener', price_kopecks: 100 },
      { id: secondId, sku: 'RUL-75', name: 'Рулетка 7.5м Greener', price_kopecks: 110 },
    ])).not.toThrow()
  })

  it('rejects an exact SKU duplicate', () => {
    expect(() => validateSupplierCatalogIdentityRows([
      { id: firstId, sku: 'BOLT-10', name: 'Болт перший', price_kopecks: 100 },
      { id: secondId, sku: 'bolt-10', name: 'Болт другий', price_kopecks: 110 },
    ])).toThrow('вже існує')
  })

  it('rejects barcode and SKU that point to different rows', () => {
    expect(() => validateSupplierCatalogIdentityRows([
      { id: firstId, sku: 'ONE', barcode: '2000000000001', name: 'Один', price_kopecks: 100 },
      { id: secondId, sku: 'TWO', barcode: '2000000000002', name: 'Два', price_kopecks: 110 },
      { id: '33333333-3333-4333-8333-333333333333', sku: 'ONE', barcode: '2000000000002', name: 'Конфлікт', price_kopecks: 120 },
    ])).toThrow('різні чернові позиції')
  })
})
