import { describe, expect, it, vi } from 'vitest'
import { loadDesktopAutocompleteSuggestions } from './productAutocompleteSearch'

const product = {
  id: 'product-1', tenant_id: 'tenant', sku: 'SKU-1', name: 'Товар', barcode: null,
  brand_id: null, category_id: null, unit: 'шт', purchase_price: 100, retail_price: 150,
  qty_on_hand: 0, reorder_point: 0, is_active: true, is_service: false,
  storage_bin: null, created_at: '', updated_at: '',
}

describe('loadDesktopAutocompleteSuggestions', () => {
  it('loads the local supplier catalog without a server request', async () => {
    const searchProducts = vi.fn().mockResolvedValue([product])
    const searchSupplier = vi.fn().mockResolvedValue([{
      id: 'draft-1', sku: 'SUP-1', name: 'Замовний товар', price_kopecks: 100,
    }])

    const result = await loadDesktopAutocompleteSuggestions('товар', false, searchProducts, searchSupplier)

    expect(searchProducts).toHaveBeenCalledWith('товар', 12)
    expect(searchSupplier).toHaveBeenCalledWith('товар', 8)
    expect(result.supplierCatalog).toHaveLength(1)
  })

  it('never loads supplier prices in warehouse-only mode', async () => {
    const searchSupplier = vi.fn().mockResolvedValue([])
    const result = await loadDesktopAutocompleteSuggestions(
      'товар', true, vi.fn().mockResolvedValue([product]), searchSupplier,
    )

    expect(searchSupplier).not.toHaveBeenCalled()
    expect(result.supplierCatalog).toEqual([])
  })

  it('does not duplicate a supplier row already matched to a shown product', async () => {
    const result = await loadDesktopAutocompleteSuggestions(
      'товар', false, vi.fn().mockResolvedValue([product]), vi.fn().mockResolvedValue([{
        id: 'draft-1', sku: 'SUP-1', name: 'Товар постачальника', price_kopecks: 100,
        matched_product_id: 'product-1',
      }]),
    )

    expect(result.supplierCatalog).toEqual([])
  })
})
