import type { Product } from '@/types/product'
/** Inline edits must update accumulated pages, not just the latest response. */
export function updateCatalogPages(pages: Record<number, Product[]>, id: string, patch: Partial<Product>): Record<number, Product[]> {
  return Object.fromEntries(Object.entries(pages).map(([page, rows]) => [page,
    rows.map(row => row.id === id ? { ...row, ...patch, id } : row)]))
}
