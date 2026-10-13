import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ localMode: true, local: vi.fn(), remote: vi.fn() }))
vi.mock('@/lib/desktopBridge', () => ({ desktopBridge: () => mocks.localMode ? { orders: { list: mocks.local } } : null }))
vi.mock('@/lib/api', () => ({ api: { get: mocks.remote } }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ session: null }) } }))
import { readOrderHistoryPage } from './orderHistoryPage'

const rows = Array.from({ length: 26 }, (_, i) => ({ id: String(i), customer_id: 'customer', chat_id: 'chat' }))
beforeEach(() => { vi.clearAllMocks(); mocks.localMode = true; mocks.local.mockResolvedValue(rows) })
describe('scoped customer/chat history pages', () => {
  it('scopes the local read before the lookahead limit and advances by raw rows', async () => {
    const page = await readOrderHistoryPage({ customer_id: 'customer' }, 25)
    expect(mocks.local).toHaveBeenCalledWith(expect.objectContaining({ customer_id: 'customer', offset: 25, limit: 26 }))
    expect(page.data).toHaveLength(25); expect(page.hasMore).toBe(true); expect(page.nextOffset).toBe(50)
    expect(mocks.remote).not.toHaveBeenCalled()
  })
  it('passes both scopes to the remote endpoint, without an unfiltered lookup', async () => {
    mocks.localMode = false
    mocks.remote.mockResolvedValue({ data: rows.slice(0, 3), meta: { offset: 10, per_page: 10, has_more: false } })
    const page = await readOrderHistoryPage({ customer_id: 'customer', chat_id: 'chat' }, 10, 10)
    expect(page.nextOffset).toBe(13)
    const url = new URL(mocks.remote.mock.calls[0][0], 'https://synthetic.invalid')
    expect(Object.fromEntries(url.searchParams)).toEqual({ offset: '10', per_page: '10', customer_id: 'customer', chat_id: 'chat' })
    expect(mocks.local).not.toHaveBeenCalled()
  })
  it('does not fall back to the cloud after a local history failure', async () => {
    mocks.local.mockRejectedValue(Error('Hub unavailable'))
    await expect(readOrderHistoryPage({ customer_id: 'customer' })).rejects.toThrow('Hub unavailable')
    expect(mocks.remote).not.toHaveBeenCalled()
  })
  it.each([{ state: 'cached' }, { state: 'pending', history_incomplete: true }])('marks $state local results as incomplete', async lan_sync => {
    mocks.local.mockResolvedValue([{ ...rows[0], lan_sync }])
    expect((await readOrderHistoryPage({ customer_id: 'customer' })).incomplete).toBe(true)
  })
  it('refuses an unscoped history read', async () => {
    await expect(readOrderHistoryPage({})).rejects.toThrow('Не вказано')
    expect(mocks.local).not.toHaveBeenCalled()
  })
  it.each([
    { data: [], meta: undefined },
    { data: [], meta: { offset: 0, per_page: 25 } },
    { data: [], meta: { offset: 1, per_page: 25, has_more: false } },
    { data: [], meta: { offset: 0, per_page: 25, has_more: true } },
    { data: [{ ...rows[0], customer_id: 'other' }], meta: { offset: 0, per_page: 25, has_more: false } },
  ])('does not treat malformed/mixed history as complete', async response => {
    mocks.localMode = false; mocks.remote.mockResolvedValue(response)
    await expect(readOrderHistoryPage({ customer_id: 'customer' })).rejects.toThrow('повноту')
  })
})
