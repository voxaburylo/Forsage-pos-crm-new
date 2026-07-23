import { api } from '@/lib/api'
import type { Product, PaginatedProducts, ProductFormData } from '@/types/product'
import { hryvniaToKopecks } from '@/types/product'
import { desktopBridge, desktopProductToProduct, type DesktopProduct } from '@/lib/desktopBridge'
import { useAuthStore } from '@/stores/authStore'
import { performCatalogDelete } from './catalogDeletePermissions'

export interface StockBreakdown {
  on_hand: number
  reserved: number
  available: number
}

export interface ProductCrossNumber {
  id: string
  number: string
  normalized_number: string
  number_type: 'cross' | 'oe' | 'supplier' | 'other'
  brand: string | null
  source: string
  is_verified: boolean
  created_at: string
}

export interface ProductFilters {
  search?: string
  category_id?: string
  brand_id?: string
  is_active?: string
  low_stock?: string
  stock_filter?: 'negative' | 'no_price'
  page?: number
  per_page?: number
  sort_field?: 'sku' | 'name' | 'retail_price' | 'qty_on_hand' | 'created_at'
  sort_dir?: 'asc' | 'desc'
}

type ProductRequestOptions = {
  silent?: boolean
  timeoutMs?: number
  reuseExistingSku?: boolean
}

function buildQuery(filters: ProductFilters): string {
  const params = new URLSearchParams()
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== '') params.set(k, String(v))
  })
  return params.toString() ? `?${params.toString()}` : ''
}

function cleanSpecs(raw: Record<string, string> | undefined | null): Record<string, string> | null {
  if (!raw) return null
  const specs: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v !== '' && v !== null && v !== undefined) specs[k] = String(v)
  }
  return Object.keys(specs).length > 0 ? specs : null
}

export async function mirrorProductToDesktop(product: Product): Promise<void> {
  const desktopCatalog = desktopBridge()?.catalog
  if (!desktopCatalog?.upsertProduct) return
  try {
    await desktopCatalog.upsertProduct({
      id: product.id,
      sku: product.sku,
      name: product.name,
      barcode: product.barcode,
      ...(Array.isArray(product.additional_barcodes) ? { additional_barcodes: product.additional_barcodes } : {}),
      brand_id: product.brand_id,
      category_id: product.category_id,
      unit: product.unit,
      purchase_price: product.purchase_price,
      retail_price: product.retail_price,
      qty_on_hand: product.qty_on_hand,
      reorder_point: product.reorder_point,
      notes: product.notes,
      is_active: product.is_active,
      is_service: product.is_service,
      requires_core_return: product.requires_core_return === true,
      core_deposit_amount: Number(product.core_deposit_amount ?? 0),
      storage_bin: product.storage_bin,
      is_favorite: product.is_favorite === true,
      photo_url: product.photo_url,
      specs: product.specs ?? {},
    })
  } catch {
    // API вже зберіг товар; локальний каталог підтягнеться наступною синхронізацією.
  }
}
// Create — требует ВСЕ поля формы, маппит с дефолтами.
function formToCreatePayload(form: ProductFormData) {
  return {
    sku: form.sku,
    name: form.name,
    barcode: form.barcode || null,
    brand_id: form.brand_id || null,
    category_id: form.category_id || null,
    unit: form.unit,
    purchase_price: hryvniaToKopecks(form.purchase_price),
    retail_price: hryvniaToKopecks(form.retail_price),
    qty_on_hand: parseFloat(form.qty_on_hand || '0'),
    reorder_point: parseFloat(form.reorder_point || '0'),
    notes: form.notes || null,
    is_active: form.is_active,
    is_service: form.is_service ?? false,
    storage_bin: form.storage_bin || null,
    is_favorite: form.is_favorite,
    specs: cleanSpecs(form.specs),
    photo_url: form.photo_url || null,
    requires_core_return: form.requires_core_return ?? false,
    core_deposit_amount: hryvniaToKopecks(form.core_deposit_amount),
  }
}

// Update — маппит ТОЛЬКО переданные ключи. Поля, отсутствующие в partial,
// в payload не попадают и на бэке остаются неизменными.
// Не использовать formToCreatePayload для partial — он заполнит отсутствующие
// поля дефолтами (0/null) и обнулит товар.
function formToUpdatePayload(partial: Partial<ProductFormData>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (partial.sku !== undefined)            out.sku = partial.sku
  if (partial.name !== undefined)           out.name = partial.name
  if (partial.barcode !== undefined)        out.barcode = partial.barcode || null
  if (partial.brand_id !== undefined)       out.brand_id = partial.brand_id || null
  if (partial.category_id !== undefined)    out.category_id = partial.category_id || null
  if (partial.unit !== undefined)           out.unit = partial.unit
  if (partial.purchase_price !== undefined) out.purchase_price = hryvniaToKopecks(partial.purchase_price)
  if (partial.retail_price !== undefined)   out.retail_price = hryvniaToKopecks(partial.retail_price)
  if (partial.qty_on_hand !== undefined)    out.qty_on_hand = parseFloat(partial.qty_on_hand || '0')
  if (partial.reorder_point !== undefined)  out.reorder_point = parseFloat(partial.reorder_point || '0')
  if (partial.notes !== undefined)          out.notes = partial.notes || null
  if (partial.is_active !== undefined)      out.is_active = partial.is_active
  if (partial.is_service !== undefined)     out.is_service = partial.is_service
  if (partial.storage_bin !== undefined)    out.storage_bin = partial.storage_bin || null
  if (partial.is_favorite !== undefined)    out.is_favorite = partial.is_favorite
  if (partial.specs !== undefined)          out.specs = cleanSpecs(partial.specs)
  if (partial.photo_url !== undefined)      out.photo_url = partial.photo_url || null
  if (partial.requires_core_return !== undefined) out.requires_core_return = partial.requires_core_return
  if (partial.core_deposit_amount !== undefined)  out.core_deposit_amount = hryvniaToKopecks(partial.core_deposit_amount)
  return out
}

export function requestDesktopSync(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
  }
}

type DesktopProductSavePayload = NonNullable<NonNullable<ReturnType<typeof desktopBridge>>['catalog']['saveProduct']> extends (product: infer Product) => Promise<DesktopProduct>
  ? Product
  : never

function desktopCreatePayload(id: string, form: ProductFormData): DesktopProductSavePayload {
  const payload = formToCreatePayload(form)
  return { id, ...payload } as DesktopProductSavePayload
}

function desktopExistingSpecs(product: DesktopProduct): Record<string, string> {
  const raw = product.specs_json
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
function desktopUpdatePayload(id: string, existing: DesktopProduct, form: Partial<ProductFormData>): DesktopProductSavePayload {
  return {
    id,
    sku: form.sku ?? existing.sku,
    name: form.name ?? existing.name,
    barcode: form.barcode !== undefined ? (form.barcode || null) : existing.barcode,
    brand_id: form.brand_id !== undefined ? (form.brand_id || null) : (existing.brand_id ?? null),
    category_id: form.category_id !== undefined ? (form.category_id || null) : (existing.category_id ?? null),
    unit: form.unit ?? existing.unit,
    purchase_price: form.purchase_price !== undefined ? hryvniaToKopecks(form.purchase_price) : existing.purchase_price,
    retail_price: form.retail_price !== undefined ? hryvniaToKopecks(form.retail_price) : existing.retail_price,
    qty_on_hand: form.qty_on_hand !== undefined ? parseFloat(form.qty_on_hand || '0') : Number(existing.qty_on_hand ?? 0),
    reorder_point: form.reorder_point !== undefined ? parseFloat(form.reorder_point || '0') : Number(existing.reorder_point ?? 0),
    notes: form.notes !== undefined ? (form.notes || null) : (existing.notes ?? null),
    is_active: form.is_active !== undefined ? form.is_active : existing.is_active === 1,
    is_service: form.is_service !== undefined ? form.is_service : existing.is_service === 1,
    requires_core_return: form.requires_core_return !== undefined
      ? form.requires_core_return
      : existing.requires_core_return === 1,
    core_deposit_amount: form.core_deposit_amount !== undefined
      ? hryvniaToKopecks(form.core_deposit_amount)
      : Number(existing.core_deposit_amount ?? 0),
    storage_bin: form.storage_bin !== undefined ? (form.storage_bin || null) : existing.storage_bin,
    is_favorite: form.is_favorite !== undefined ? form.is_favorite : existing.is_favorite === 1,
    photo_url: form.photo_url !== undefined ? (form.photo_url || null) : (existing.photo_url ?? null),
    specs: form.specs ?? desktopExistingSpecs(existing),
  } as DesktopProductSavePayload
}
export const productApi = {
  list: async (filters: ProductFilters = {}) => {
    const local = desktopBridge()?.catalog.listProducts
    if (local) {
      const page = Math.max(1, filters.page ?? 1)
      const perPage = Math.max(1, Math.min(500, filters.per_page ?? 50))
      const result = await local({
        query: filters.search,
        categoryId: filters.category_id,
        brandId: filters.brand_id,
        lowStock: filters.low_stock === 'true',
        stockFilter: filters.stock_filter ?? '',
        limit: perPage,
        offset: (page - 1) * perPage,
        sortField: filters.sort_field === 'created_at' ? undefined : filters.sort_field,
        sortDir: filters.sort_dir,
      })
      return {
        data: result.data.map(desktopProductToProduct),
        pagination: {
          page,
          per_page: perPage,
          total: result.total,
          total_pages: Math.max(1, Math.ceil(result.total / perPage)),
        },
      }
    }
    return api.get<PaginatedProducts>(`/api/v1/products${buildQuery(filters)}`)
  },

  get: async (id: string) => {
    const local = desktopBridge()?.catalog.findById
    if (local) {
      const product = await local(id)
      if (!product) throw new Error('Товар не знайдено')
      return { data: desktopProductToProduct(product) }
    }
    return api.get<{ data: Product }>(`/api/v1/products/${id}`)
  },

  search: async (q: string, limit = 10, opts?: ProductRequestOptions) => {
    const local = desktopBridge()?.catalog.searchProducts
    if (local) return { data: (await local(q, limit)).map(desktopProductToProduct) }
    return api.get<{ data: Product[] }>(`/api/v1/products/search?q=${encodeURIComponent(q)}&limit=${limit}`, opts)
  },
  create: async (form: ProductFormData, opts?: ProductRequestOptions) => {
    const desktopCatalog = desktopBridge()?.catalog
    if (desktopCatalog?.saveProduct) {
      const saved = await desktopCatalog.saveProduct(
        desktopCreatePayload(crypto.randomUUID(), form),
        { reuseExistingSku: opts?.reuseExistingSku === true },
      )
      requestDesktopSync()
      return { data: desktopProductToProduct(saved) }
    }

    const response = await api.post<{ data: Product }>('/api/v1/products', formToCreatePayload(form), undefined, opts)
    await mirrorProductToDesktop(response.data)
    return response
  },

  update: async (id: string, form: Partial<ProductFormData>, opts?: ProductRequestOptions) => {
    const desktopCatalog = desktopBridge()?.catalog
    if (desktopCatalog?.saveProduct && desktopCatalog.findById) {
      const existing = await desktopCatalog.findById(id)
      if (!existing) throw new Error('Товар не знайдено в локальній базі')
      const saved = await desktopCatalog.saveProduct(desktopUpdatePayload(id, existing, form))
      requestDesktopSync()
      return { data: desktopProductToProduct(saved) }
    }

    const response = await api.put<{ data: Product }>(`/api/v1/products/${id}`, formToUpdatePayload(form), opts)
    await mirrorProductToDesktop(response.data)
    return response
  },

  delete: async (id: string) => {
    const role = useAuthStore.getState().session?.user?.app_metadata?.role as string | undefined
    return performCatalogDelete(role, async () => {
      const desktopCatalog = desktopBridge()?.catalog
      if (desktopCatalog?.deleteProduct) {
        await desktopCatalog.deleteProduct(id)
        requestDesktopSync()
        return undefined as void
      }
      return api.delete<void>(`/api/v1/products/${id}`)
    })
  },

  getStock: async (id: string) => {
    const local = desktopBridge()?.catalog.findById
    if (local) {
      const product = await local(id)
      if (!product) throw new Error('Товар не знайдено')
      const onHand = Number(product.qty_on_hand ?? 0)
      const reserved = Number(product.qty_reserved ?? 0)
      const available = Number(product.qty_available ?? (onHand - reserved))
      return { data: { on_hand: onHand, reserved, available } }
    }
    return api.get<{ data: StockBreakdown }>(`/api/v1/products/${id}/stock`)
  },

  priceHistory: (id: string) =>
    desktopBridge() && useAuthStore.getState().offlineMode ? Promise.resolve({ data: [] as unknown[] }) : api.get<{ data: unknown[] }>(`/api/v1/products/${id}/price-history`),

  generateBarcode: async (id: string) => {
    const desktopCatalog = desktopBridge()?.catalog
    if (desktopCatalog?.generateBarcode && desktopCatalog.saveProduct && desktopCatalog.findById) {
      const existing = await desktopCatalog.findById(id)
      if (!existing) throw new Error('Товар не знайдено')
      if (existing.barcode) return { data: desktopProductToProduct(existing) }
      const barcode = await desktopCatalog.generateBarcode()
      const saved = await desktopCatalog.saveProduct(desktopUpdatePayload(id, existing, { barcode }))
      requestDesktopSync()
      return { data: desktopProductToProduct(saved) }
    }
    const response = await api.post<{ data: Product }>(`/api/v1/products/${id}/generate-barcode`, {})
    await mirrorProductToDesktop(response.data)
    return response
  },

  merge: (primaryId: string, duplicateId: string) =>
    api.post<{ data: Product }>('/api/v1/products/merge', {
      primary_product_id: primaryId,
      duplicate_product_id: duplicateId,
    }),

  getAnalogs: (id: string) =>
    desktopBridge() && useAuthStore.getState().offlineMode ? Promise.resolve({ analogs: [], grouped: {} }) : api.get<{ analogs: any[]; grouped: Record<string, any[]> }>(`/api/v1/products/${id}/analogs`),

  addAnalog: (id: string, analogProductId: string, analogType: 'substitute' | 'oem' | 'cross') =>
    api.post(`/api/v1/products/${id}/analogs`, {
      analog_product_id: analogProductId,
      analog_type: analogType,
    }),

  removeAnalog: (id: string, analogId: string) =>
    api.delete(`/api/v1/products/${id}/analogs/${analogId}`),

  getCrossNumbers: (id: string) =>
    desktopBridge() && useAuthStore.getState().offlineMode ? Promise.resolve({ data: [] as ProductCrossNumber[] }) : api.get<{ data: ProductCrossNumber[] }>(`/api/v1/products/${id}/cross-numbers`),

  addCrossNumbers: (
    id: string,
    numbers: string[],
    numberType: ProductCrossNumber['number_type'],
    source: string,
  ) =>
    api.post<{ data: ProductCrossNumber[] }>(`/api/v1/products/${id}/cross-numbers`, {
      numbers,
      number_type: numberType,
      source,
    }),

  removeCrossNumber: (id: string, crossNumberId: string) =>
    api.delete(`/api/v1/products/${id}/cross-numbers/${crossNumberId}`),

  importCrossNumbers: (text: string, source?: string) =>
    api.post<{ data: { linked: number; products: number; not_found: number; not_found_skus: string[]; skipped_dup: number } }>(
      '/api/v1/products/cross-numbers/import',
      { text, source },
    ),

  getFitment: (id: string) =>
    desktopBridge() && useAuthStore.getState().offlineMode ? Promise.resolve({ fitments: [], grouped: {} }) : api.get<{ fitments: any[]; grouped: Record<string, any[]> }>(`/api/v1/products/${id}/fitment`),

  getHistory: (id: string) =>
    desktopBridge() && useAuthStore.getState().offlineMode ? Promise.resolve({ data: [] as any[] }) : api.get<{ data: any[] }>(`/api/v1/products/${id}/history`),

  getSupplierPrices: (id: string) =>
    desktopBridge() && useAuthStore.getState().offlineMode ? Promise.resolve({ data: [] }) : api.get<{ data: Array<{ supplier_id: string; supplier_name: string; price: number; date: string }> }>(`/api/v1/products/${id}/supplier-prices`),

  getCobuy: (id: string) =>
    desktopBridge() && useAuthStore.getState().offlineMode ? Promise.resolve([] as any[]) : api.get<any[]>(`/api/v1/products/${id}/cobuy`),

  generateBarcodeOnly: async () => {
    const local = desktopBridge()?.catalog.generateBarcode
    if (local) return { data: { barcode: await local() } }
    return api.get<{ data: { barcode: string } }>('/api/v1/products/generate-barcode-only')
  },
}
