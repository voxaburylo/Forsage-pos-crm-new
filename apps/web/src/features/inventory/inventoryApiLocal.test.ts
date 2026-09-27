import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ bridge: vi.fn(), edit: vi.fn(), remove: vi.fn(), complete: vi.fn(), price: vi.fn(), remote: vi.fn(), sync: vi.fn() }))
vi.mock('@/lib/desktopBridge', () => ({ desktopBridge: mocks.bridge }))
vi.mock('@/lib/api', () => ({ api: { get: mocks.remote, post: mocks.remote, put: mocks.remote, delete: mocks.remote } }))
vi.mock('@/features/products/productApi', () => ({ requestDesktopSync: mocks.sync, desktopCreatePayload: vi.fn() }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ session: { user: { id: 'cashier' } } }) } }))
import { inventoryApi } from './inventoryApi'
beforeEach(() => {
  vi.resetAllMocks()
  mocks.bridge.mockReturnValue({ inventory: { updateProducts: mocks.edit, removeItem: mocks.remove, complete: mocks.complete, applyPrice: mocks.price } })
})
it('passes one complete product batch with baselines to local storage', async () => {
  const edits = [{ product_id: 'p', values: { retail_price: 1200 }, base: { retail_price: 1000, purchase_price: 800 } }]
  mocks.edit.mockResolvedValue([{ id: 'p', retail_price: 1200 }])
  expect(await inventoryApi.updateProducts('i', edits)).toEqual([{ id: 'p', retail_price: 1200 }])
  expect(mocks.edit).toHaveBeenCalledExactlyOnceWith('i', { edits })
  expect(mocks.sync).toHaveBeenCalledOnce()
  expect(mocks.remote).not.toHaveBeenCalled()
})
it('never falls back to remote or partial writes after local rejection', async () => {
  mocks.edit.mockRejectedValue(new Error('DOCUMENT_CONFLICT'))
  await expect(inventoryApi.updateProducts('i', [])).rejects.toThrow('DOCUMENT_CONFLICT')
  expect(mocks.sync).not.toHaveBeenCalled()
  expect(mocks.remote).not.toHaveBeenCalled()
})
it.each([null, { inventory: {} }])('requires an updated local bridge %j', bridge => {
  mocks.bridge.mockReturnValue(bridge)
  return expect(inventoryApi.updateProducts('i', [])).rejects.toThrow('актуальної локальної програми')
})
it('transmits reviewed delete and complete revisions and the authenticated actor', async () => {
  await inventoryApi.removeItem('i', 'row', { expectedRevision: 'opened-row' })
  expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('i', 'row', undefined, 'opened-row')
  await inventoryApi.complete('i', { expectedRevision: 'opened-session' })
  expect(mocks.complete).toHaveBeenCalledExactlyOnceWith('i', { expected_revision: 'opened-session', user_id: 'cashier' })
  expect(mocks.remote).not.toHaveBeenCalled()
})
it('sends the previous price when acknowledging a price-label mismatch', async () => {
  const input = { product_id: 'p', retail_price: 2000, expected_price: 1500 }
  await inventoryApi.applyPrice('i', input)
  expect(mocks.price).toHaveBeenCalledExactlyOnceWith('i', input)
  expect(mocks.remote).not.toHaveBeenCalled()
})
