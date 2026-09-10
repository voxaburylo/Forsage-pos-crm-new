import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), remote: vi.fn() }))
vi.mock('@/lib/desktopBridge', () => ({ desktopBridge: () => ({ pos: { listCustomers: mocks.list, getCustomer: mocks.get } }) }))
vi.mock('@/lib/api', () => ({ api: { get: mocks.remote } }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ session: null }) } }))
import { customerApi } from './customerApi'
describe('local customer reads', () => {
  beforeEach(() => vi.clearAllMocks())
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
})
