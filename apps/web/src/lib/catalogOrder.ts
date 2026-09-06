interface SortableProduct {
  id: string
  name?: string
  sku?: string
  barcode?: string | null
  qty_on_hand?: number
  qty_available?: number
  is_service?: boolean | number
  is_favorite?: boolean | number
  brand?: { name?: string } | null
  brand_name?: string | null
  retail_price?: number
  created_at?: string
}

export function hasAvailableStock(p: SortableProduct): boolean {
  return p.is_service === true || p.is_service === 1 || Number(p.qty_available ?? p.qty_on_hand ?? 0) > 0
}

// Must be applied to the complete matching set BEFORE slicing a cache page.
export function catalogComparator(options: { search?: string; sortField?: string; sortDir?: 'asc' | 'desc' } = {}) {
  const query = String(options.search ?? '').trim()
  const field = options.sortField
  const direction = options.sortDir === 'desc' ? -1 : 1
  const exact = (p: SortableProduct) => query !== '' && (p.sku === query || p.barcode === query)
  const value = (p: SortableProduct) => {
    if (field === 'qty_on_hand') return Number(p.qty_available ?? p.qty_on_hand ?? 0)
    if (field === 'retail_price') return Number(p.retail_price ?? 0)
    if (field === 'brand') return p.brand?.name ?? p.brand_name ?? ''
    if (field === 'sku') return p.sku ?? ''
    if (field === 'created_at') return p.created_at ?? ''
    return p.name ?? ''
  }
  return (a: SortableProduct, b: SortableProduct): number => {
    const stockOrder = Number(hasAvailableStock(b)) - Number(hasAvailableStock(a))
    if (stockOrder) return stockOrder
    const exactOrder = Number(exact(b)) - Number(exact(a))
    if (exactOrder) return exactOrder
    if (!field) {
      const favoriteOrder = Number(Boolean(b.is_favorite)) - Number(Boolean(a.is_favorite))
      if (favoriteOrder) return favoriteOrder
    }
    const left = value(a)
    const right = value(b)
    const compared = typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left).localeCompare(String(right), 'uk', { sensitivity: 'base' })
    return compared * (field ? direction : 1)
      || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'uk', { sensitivity: 'base' })
      || a.id.localeCompare(b.id)
  }
}
