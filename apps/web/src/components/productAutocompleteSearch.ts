import type { Product } from '@/types/product'

export interface SupplierProductSuggestion {
  id: string
  sku: string
  barcode?: string | null
  brand?: string | null
  name: string
  price_kopecks: number
  qty?: string
  warehouse_name?: string | null
  supplier_id?: string | null
  matched_product_id?: string | null
  supplier?: { id: string; name: string }
}

export async function loadDesktopAutocompleteSuggestions(
  query: string,
  warehouseOnly: boolean,
  searchProducts: (query: string, limit: number) => Promise<Product[]>,
  searchSupplierCatalog: (query: string, limit: number) => Promise<SupplierProductSuggestion[]>,
): Promise<{ warehouse: Product[]; supplierCatalog: SupplierProductSuggestion[] }> {
  const [warehouse, supplierCatalog] = await Promise.all([
    searchProducts(query, 12),
    warehouseOnly ? Promise.resolve([]) : searchSupplierCatalog(query, 8),
  ])
  const warehouseIds = new Set(warehouse.map((product) => product.id))
  return {
    warehouse,
    supplierCatalog: supplierCatalog.filter((item) => (
      !item.matched_product_id || !warehouseIds.has(item.matched_product_id)
    )),
  }
}
