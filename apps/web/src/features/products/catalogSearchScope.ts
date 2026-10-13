export type CatalogSearchScope = {
  category: string
  brand: string
  lowStock: boolean
  stock: '' | 'negative' | 'no_price'
}

/** Scope transition shared by typed search and the existing barcode scanner. */
export function catalogSearchScope(current: CatalogSearchScope, source: 'text' | 'scan', search: string): CatalogSearchScope {
  return source === 'scan' && search.trim()
    ? { category: '', brand: '', lowStock: false, stock: '' }
    : current
}
