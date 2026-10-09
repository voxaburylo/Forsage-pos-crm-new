import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ bridge: vi.fn(), sync: vi.fn(), request: vi.fn(), upload: vi.fn(), importRows: vi.fn() }))
vi.mock('@/lib/desktopBridge', () => ({ desktopBridge: mocks.bridge, desktopProductToProduct: vi.fn() }))
vi.mock('@/lib/api', () => ({ request: mocks.request }))
vi.mock('@/lib/processingUploads', () => ({ removeProcessingUploads: vi.fn(), uploadProcessingBlob: mocks.upload }))
vi.mock('@/features/products/productApi', () => ({ requestDesktopSync: mocks.sync, productApi: {} }))
vi.mock('@/features/admin/pricingApi', () => ({ pricingApi: {} }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ session: { user: { id: 'cashier', tenant_id: 'test' } } }) } }))
import { supplierImportsApi } from './supplierImportsApi'
import { buildSupplierImportRows } from './supplierImportLocal'

const mapping = { sku: 0, name: 1, qty: 2, price: 3, barcode: null, brand: null }
const values = new Map<string, string>()
const storage = { getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } } as Storage
afterEach(() => vi.unstubAllGlobals())
beforeEach(() => {
  vi.clearAllMocks(); values.clear(); vi.stubGlobal('localStorage', storage)
  mocks.bridge.mockReturnValue({ supplierCatalog: { list: vi.fn(), importRows: mocks.importRows, importOperationIds: true, resolveImport: vi.fn() }, catalog: { listProducts: vi.fn() } })
})
it.each(['add', 'replace'] as const)('blocks partial %s import before IPC/upload, with the source row in the error', async mode => {
  const preview = buildSupplierImportRows([['A', 'Good', '2', '12'], ['B', 'Bad', '98oops', '12']], mapping, 0)
  expect(preview.rows).toHaveLength(1)
  for (const local of [true, false]) {
    if (!local) mocks.bridge.mockReturnValue(null)
    await expect(supplierImportsApi.uploadRows('example.xlsx', preview.rows, { supplierId: null, mode, parseErrors: preview.errors }))
      .rejects.toThrow(/Рядок 2/)
  }
  expect(mocks.importRows).not.toHaveBeenCalled()
  expect(mocks.upload).not.toHaveBeenCalled()
  expect(mocks.request).not.toHaveBeenCalled()
  expect(mocks.sync).not.toHaveBeenCalled()
})
it('passes exact decimal values from Excel to the local catalog and schedules its copy once', async () => {
  const preview = buildSupplierImportRows([['A', 'Good', '0,125', '1 234,56']], mapping, 0)
  mocks.importRows.mockResolvedValue({ success: true, importId: 'result' })
  await supplierImportsApi.uploadRows('example.xlsx', preview.rows, { supplierId: null, mode: 'replace', parseErrors: preview.errors })
  expect(mocks.importRows.mock.calls[0][1][0]).toMatchObject({ qty: '0.125', price_kopecks: 123456 })
  expect(mocks.sync).toHaveBeenCalledTimes(1)
  expect(mocks.upload).not.toHaveBeenCalled()
})

it('refuses older EXE without replay support before any write', async () => {
  mocks.bridge.mockReturnValue({ supplierCatalog: { list: vi.fn(), importRows: mocks.importRows }, catalog: { listProducts: vi.fn() } })
  await expect(supplierImportsApi.uploadRows('file.csv', [], { supplierId: null, mode: 'add' })).rejects.toThrow(/Оновіть/)
  expect(mocks.importRows).not.toHaveBeenCalled()
  expect(mocks.upload).not.toHaveBeenCalled()
})
it('sends an immutable copy of exactly the payload whose attempt was saved', async () => {
  const preview = buildSupplierImportRows([['A', 'Good', '0,125', '1 234,56']], mapping, 0)
  mocks.importRows.mockResolvedValue({ success: true, importId: 'result' })
  const pending = supplierImportsApi.uploadRows('file.csv', preview.rows, { supplierId: null, mode: 'add' })
  preview.rows[0].qty = '999'
  await pending
  const args = mocks.importRows.mock.calls[0]
  expect(args[1][0].qty).toBe('0.125')
  expect(args[2]).toMatchObject({ user_id: 'cashier', tenant_id: 'test', operation_id: expect.any(String) })
})
it('a copy scheduling failure cannot turn a committed import into a retry', async () => {
  const preview = buildSupplierImportRows([['A', 'Good', '1', '12']], mapping, 0)
  mocks.importRows.mockResolvedValue({ success: true, importId: 'result' })
  mocks.sync.mockImplementationOnce(() => { throw Error('copy offline') })
  await expect(supplierImportsApi.uploadRows('file.csv', preview.rows, { supplierId: null, mode: 'add' }))
    .resolves.toEqual({ success: true, importId: 'result' })
  expect(values.size).toBe(0)
})
