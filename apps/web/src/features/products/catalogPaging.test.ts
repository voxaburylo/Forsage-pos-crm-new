import { describe, expect, it, vi } from 'vitest'
import { loadCatalogPage } from './catalogPaging'
import type { PaginatedProducts } from '@/types/product'

const result: PaginatedProducts = { data: [], pagination: { page: 6, per_page: 100, total: 780, total_pages: 8 } }
describe('catalog page source', () => {
  it('uses the paginated local API for named searches beyond the former 500-result cap', async () => {
    const list = vi.fn().mockResolvedValue(result)
    const cache = vi.fn()
    const filters = { search: 'фільтр', page: 6, per_page: 100 }
    expect(await loadCatalogPage(filters, true, null, { list, cache })).toEqual({ result, source: 'desktop' })
    expect(list).toHaveBeenCalledWith(filters)
    expect(cache).not.toHaveBeenCalled()
  })
  it('never replaces a failed local lookup with a different database', async () => {
    const cache = vi.fn().mockResolvedValue(result)
    await expect(loadCatalogPage({}, true, null, { list: vi.fn().mockRejectedValue(new Error('local error')), cache }))
      .rejects.toThrow('local error')
    expect(cache).not.toHaveBeenCalled()
  })
  it('does not append cached pages to server pages after a network failure', async () => {
    const cache = vi.fn().mockResolvedValue(result)
    await expect(loadCatalogPage({ page: 2 }, false, 'server', { list: vi.fn().mockRejectedValue(new Error('offline')), cache }))
      .rejects.toThrow('offline')
    expect(cache).not.toHaveBeenCalled()
  })
  it('keeps a cache-based list on the same source during scrolling', async () => {
    const list = vi.fn().mockResolvedValue(result)
    const cache = vi.fn().mockResolvedValue(result)
    expect((await loadCatalogPage({ page: 2 }, false, 'cache', { list, cache })).source).toBe('cache')
    expect(list).not.toHaveBeenCalled()
    expect(cache).toHaveBeenCalledWith({ page: 2 })
  })
})
