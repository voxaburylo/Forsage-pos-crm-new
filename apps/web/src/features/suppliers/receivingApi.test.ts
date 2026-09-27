import { beforeEach, afterEach, it, expect, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ bridge: vi.fn(), sync: vi.fn(), post: vi.fn(), commit: vi.fn() }))
vi.mock('@/lib/desktopBridge', () => ({ desktopBridge: mocks.bridge }))
vi.mock('@/features/products/productApi', () => ({ requestDesktopSync: mocks.sync }))
vi.mock('@/lib/api', () => ({ api: { post: mocks.post } }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ session: { user: { id: 'cashier' } } }) } }))
import { supplierApi } from './supplierApi'
import { invoiceProductBase, loadSupplyInvoiceDraft, saveSupplyInvoiceDraft } from './invoiceFormModel'
const values = new Map<string, string>()
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } as unknown as Storage
const input = { invoice_id: 'stable-invoice', supplier_id: 'supplier', invoice_number: null, notes: null,
  items: [{ client_key: 'row', product_name: 'Круг', sku: 'C', qty: 98, purchase_price: 1000, retail_price: 1500, total: 98000, category_id: null }], payments: [] }
beforeEach(() => { values.clear(); vi.clearAllMocks(); mocks.commit.mockReset(); mocks.bridge.mockReturnValue({ supply: { commitReceiving: mocks.commit } }); vi.stubGlobal('localStorage', storage) })
afterEach(() => vi.unstubAllGlobals())
it('persists operation before IPC and reuses it after a lost reply', async () => {
  mocks.commit.mockImplementationOnce(async () => { expect(values.size).toBe(1); throw Error('Lost reply') }).mockResolvedValueOnce({ id: input.invoice_id, status: 'posted' })
  await expect(supplierApi.commitReceiving(input)).rejects.toThrow('Lost reply')
  expect(values.size).toBe(1)
  expect((await supplierApi.commitReceiving(input)).data.id).toBe(input.invoice_id)
  const [first, second] = mocks.commit.mock.calls.map(call => call[0])
  expect(first.operation_id).toBe(second.operation_id); expect(first.user_id).toBe('cashier')
  expect(values.size).toBe(0); expect(mocks.sync).toHaveBeenCalledTimes(1)
})
it('one double click is one IPC and does not split into card/payment/post writes', async () => {
  mocks.commit.mockResolvedValue({ id: input.invoice_id, status: 'posted' })
  await Promise.all([supplierApi.commitReceiving(input), supplierApi.commitReceiving(input)])
  expect(mocks.commit).toHaveBeenCalledTimes(1); expect(mocks.post).not.toHaveBeenCalled()
})
it('never falls back to partial writes on older local builds or the read-only web', async () => {
  for (const bridge of [undefined, { supply: {} }]) {
    mocks.bridge.mockReturnValue(bridge)
    await expect(supplierApi.commitReceiving(input)).rejects.toThrow('оновіть локальну')
  }
  expect(mocks.commit).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled()
})
it('refuses writes when the durable request cannot be saved', async () => {
  vi.stubGlobal('localStorage', { ...storage, setItem: () => { throw Error('storage full') } })
  await expect(supplierApi.commitReceiving(input)).rejects.toThrow('storage full'); expect(mocks.commit).not.toHaveBeenCalled()
})
it('keeps the target invoice and original product metadata across draft reloads', () => {
  const product_base = invoiceProductBase({ name: ' Круг ', sku: ' C ', retail_price: 1500, barcode: '' })
  saveSupplyInvoiceDraft('draft', { supplierId: 's', invoiceNumber: '', notes: '', items: [{ ...input.items[0], product_base }], paidAmount: '', paymentMethod: 'cash', fundSource: 'owner_funds', commitInvoiceId: input.invoice_id })
  const loaded = loadSupplyInvoiceDraft('draft')!
  expect(loaded.commitInvoiceId).toBe(input.invoice_id); expect(loaded.items[0].product_base).toEqual(product_base)
})
