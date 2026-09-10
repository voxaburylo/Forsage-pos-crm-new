import { describe, expect, it, vi } from 'vitest'
import { canAdvanceCatalogPage, loadCatalogPage } from './catalogPaging'
import type { PaginatedProducts } from '@/types/product'

const result: PaginatedProducts = { data: [], pagination: { page: 6, per_page: 100, total: 780, total_pages: 8 } }
describe('catalog scroll boundary', () => {
  const response = (page: number, rows: number, total = 90): PaginatedProducts => ({
    data: Array.from({ length: rows }, (_, id) => ({ id: String(id) })) as PaginatedProducts['data'],
    pagination: { page, per_page: 100, total, total_pages: Math.ceil(total / 100) },
  })
  it('waits for the current search page', () => {
    expect(canAdvanceCatalogPage(1, response(4, 100, 1000), 0, false)).toBe(false)
    expect(canAdvanceCatalogPage(2, response(1, 100, 300), 100, true)).toBe(false)
  })
  it('stops on empty or final pages even with stale totals', () => {
    expect(canAdvanceCatalogPage(1, response(1, 90), 90, true)).toBe(false)
    expect(canAdvanceCatalogPage(2, response(2, 0, 1000), 30, true)).toBe(false)
  })
  it('continues only after a loaded non-final page', () => {
    expect(canAdvanceCatalogPage(2, response(2, 100, 300), 200, true)).toBe(true)
  })
  it('keeps the first 100 results before the final 12 for the belt search', () => {
    expect(canAdvanceCatalogPage(1, response(1, 100, 14242), 0, false)).toBe(false)
    expect(canAdvanceCatalogPage(1, null, 0, false)).toBe(false)
    expect(canAdvanceCatalogPage(1, response(1, 100, 112), 100, true)).toBe(true)
    expect(canAdvanceCatalogPage(2, response(1, 100, 112), 100, false)).toBe(false)
    expect(canAdvanceCatalogPage(2, response(2, 12, 112), 112, true)).toBe(false)
    expect(canAdvanceCatalogPage(3, response(3, 0, 112), 12, true)).toBe(false)
  })
})
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
