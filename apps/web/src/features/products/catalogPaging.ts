import type { ProductFilters } from './productApi'
import type { PaginatedProducts } from '@/types/product'

export type CatalogSource = 'desktop' | 'server' | 'cache'

// A scrolling list must not combine pages from different snapshots/sources.
// Desktop never falls back to the browser cache or the server.
export async function loadCatalogPage(
  filters: ProductFilters,
  desktop: boolean,
  source: CatalogSource | null,
  loaders: {
    list: (filters: ProductFilters) => Promise<PaginatedProducts>
    cache: (filters: ProductFilters) => Promise<PaginatedProducts>
  },
): Promise<{ result: PaginatedProducts; source: CatalogSource }> {
  if (desktop) return { result: await loaders.list(filters), source: 'desktop' }
  if (source === 'cache') return { result: await loaders.cache(filters), source: 'cache' }
  try {
    return { result: await loaders.list(filters), source: 'server' }
  } catch (error) {
    if (source === 'server') throw error
    const cached = await loaders.cache(filters).catch(() => null)
    if (!cached || !cached.pagination.total) throw error
    return { result: cached, source: 'cache' }
  }
}
