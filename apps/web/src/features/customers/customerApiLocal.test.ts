import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), save: vi.fn(), remote: vi.fn() }))
vi.mock('@/lib/desktopBridge', () => ({ desktopBridge: () => ({ pos: { listCustomers: mocks.list, getCustomer: mocks.get, saveCustomer: mocks.save } }) }))
vi.mock('@/lib/api', () => ({ api: { get: mocks.remote, post: mocks.remote, put: mocks.remote } }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ session: null }) } }))
import { customerApi } from './customerApi'
describe('local customer operations', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())
  it('uses SQLite for search and pagination', async () => {
    const page = { data: [{ id: 'local' }], pagination: { total: 1 } }
    mocks.list.mockResolvedValue(page)
    expect(await customerApi.list({ search: 'Коваль', page: 2 })).toBe(page)
    expect(mocks.list).toHaveBeenCalledWith({ search: 'Коваль', page: 2 })
    expect(mocks.remote).not.toHaveBeenCalled()
  })
  it('does not silently switch databases after a local failure', async () => {
    mocks.get.mockRejectedValue(new Error('Local error'))
    await expect(customerApi.get('customer')).rejects.toThrow('Local error')
    expect(mocks.remote).not.toHaveBeenCalled()
  })
  it('does not route a web-only group filter to the server', async () => {
    await expect(customerApi.list({ group_id: 'web-group' })).rejects.toThrow('недоступні')
    expect(mocks.remote).not.toHaveBeenCalled()
  })
  it('passes an existing card unchanged and returns phone-reuse attachment details', async () => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    const result = { data: { id: 'customer', card_barcode: '000123' }, meta: { reused: true, card_attached: true, vehicle_added: false } }
    mocks.save.mockResolvedValue(result)
    expect(await customerApi.create({ phone: '0501234567', card_barcode: '000123' })).toBe(result)
    expect(mocks.save).toHaveBeenCalledWith({ phone: '0501234567', card_barcode: '000123' })
    expect(mocks.remote).not.toHaveBeenCalled()
  })
  it('preserves version checking on deliberate card edits', async () => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    mocks.save.mockResolvedValue({ data: { id: 'customer', card_barcode: '000123' } })
    await customerApi.update('customer', { card_barcode: '000123', expected_updated_at: 'version' })
    expect(mocks.save).toHaveBeenCalledWith({ card_barcode: '000123', expected_updated_at: 'version', user_id: undefined }, 'customer')
    expect(mocks.remote).not.toHaveBeenCalled()
  })
  it('does not swallow a card conflict or retry it through the server', async () => {
    mocks.save.mockRejectedValue(new Error('Цей штрихкод уже належить іншому клієнту'))
    await expect(customerApi.create({ phone: '0501234567', card_barcode: '000123' })).rejects.toThrow('іншому клієнту')
    expect(mocks.save).toHaveBeenCalledOnce()
    expect(mocks.remote).not.toHaveBeenCalled()
  })
})
