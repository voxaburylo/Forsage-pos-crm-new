import { beforeEach, describe, expect, it, vi } from 'vitest'
import { productApi } from './productApi'
import { productEditorPayload } from './productFormModel'
import type { ProductFormData } from '@/types/product'

const { catalog, remote } = vi.hoisted(() => ({
  catalog: { saveProduct: vi.fn(), findById: vi.fn(), deletePhoto: vi.fn() },
  remote: { post: vi.fn(), put: vi.fn() },
}))
vi.mock('@/lib/api', () => ({ api: remote }))
vi.mock('@/lib/desktopBridge', () => ({ desktopBridge: () => ({ catalog }), desktopProductToProduct: (value: unknown) => value }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ session: { user: { app_metadata: { role: 'owner' } } } }) } }))

const form = (): ProductFormData => ({
  sku: 'NEW', name: 'New product', barcode: '00123', brand_id: '', category_id: '', unit: 'шт',
  purchase_price: '100,50', retail_price: '120,50', qty_on_hand: '98', reorder_point: '2,125',
  notes: '', is_active: true, storage_bin: '', is_favorite: false, specs: {},
})
const stored = () => ({
  id: 'product-id', sku: 'NEW', name: 'Product', barcode: '00123', purchase_price: 10050, retail_price: 12000,
  qty_on_hand: 5, reorder_point: 2, unit: 'шт', is_active: 1, is_service: 0, updated_at: 'revision-1',
  photo_url: null,
})
beforeEach(() => {
  vi.resetAllMocks()
  catalog.findById.mockImplementation(async () => stored())
  catalog.saveProduct.mockImplementation(async (input) => input)
})

describe('validated product editor to local API', () => {
  it('creates a zero-stock card with exact kopecks, no cloud request', async () => {
    await productApi.create(productEditorPayload(form(), true))
    expect(catalog.saveProduct).toHaveBeenCalledOnce()
    expect(catalog.saveProduct.mock.calls[0][0]).toMatchObject({
      sku: 'NEW', barcode: '00123', qty_on_hand: 0, purchase_price: 10050, retail_price: 12050, reorder_point: 2.125,
    })
    expect(remote.post).not.toHaveBeenCalled()
  })
  it('merges edits with current stock, not the stock observed when the card was opened', async () => {
    await productApi.update('product-id', productEditorPayload(form(), true))
    expect(catalog.saveProduct.mock.calls[0][0]).toMatchObject({
      id: 'product-id', qty_on_hand: 5, expected_updated_at: 'revision-1', retail_price: 12050,
    })
    expect(remote.put).not.toHaveBeenCalled()
  })
  it('keeps the real purchase price when the cashier has no access to it', async () => {
    await productApi.update('product-id', productEditorPayload({ ...form(), purchase_price: '0' }, false))
    expect(catalog.saveProduct.mock.calls[0][0]).toMatchObject({ purchase_price: 10050, qty_on_hand: 5 })
  })
  it('does not fall back to the internet or automatically retry an uncertain local save', async () => {
    catalog.saveProduct.mockRejectedValue(Error('Lost local reply'))
    await expect(productApi.create(productEditorPayload(form(), true))).rejects.toThrow('Lost local reply')
    expect(catalog.saveProduct).toHaveBeenCalledOnce()
    expect(remote.post).not.toHaveBeenCalled()
  })
  it('releases the local serialization queue after an update failure', async () => {
    catalog.saveProduct.mockRejectedValueOnce(Error('write failed'))
    await expect(productApi.update('product-id', productEditorPayload(form(), true))).rejects.toThrow('write failed')
    await productApi.update('product-id', productEditorPayload(form(), true))
    expect(catalog.saveProduct).toHaveBeenCalledTimes(2)
    expect(remote.put).not.toHaveBeenCalled()
  })
})
