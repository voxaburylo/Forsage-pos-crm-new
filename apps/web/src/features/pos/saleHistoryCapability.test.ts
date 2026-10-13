import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ remote: vi.fn(), local: vi.fn(), desktop: false }))
vi.mock('@/lib/api', () => ({ api: { get: mocks.remote } }))
vi.mock('@/lib/desktopBridge', () => ({ desktopBridge: () => mocks.desktop ? { pos: { listSales: mocks.local } } : null }))
vi.mock('@/lib/offlineDB', () => ({ getLocalSyncState: vi.fn() }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({}) } }))
import { saleApi } from './saleApi'
beforeEach(() => { vi.clearAllMocks(); mocks.desktop = false })
it.each([true, false])('rejects ignored advanced filters for local=%s instead of displaying wrong receipts', async desktop => {
  mocks.desktop = desktop
  const read = desktop ? mocks.local : mocks.remote
  read.mockResolvedValue({ data: [{ id: 'unfiltered' }], pagination: {} })
  await expect(saleApi.list({ history_filter_version: '1', product_search: 'Hort' })).rejects.toThrow('неповний список не показано')
  read.mockResolvedValue({ data: [], pagination: {}, filter_version: 1 })
  await expect(saleApi.list({ history_filter_version: '1', product_search: 'Hort' })).resolves.toMatchObject({ data: [] })
})
it('does not require new capabilities for an unfiltered legacy list', async () => {
  mocks.remote.mockResolvedValue({ data: [], pagination: {} })
  await expect(saleApi.list()).resolves.toMatchObject({ data: [] })
})
