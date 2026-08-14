import { request } from '@/lib/api'
import { removeProcessingUploads, uploadProcessingBlob } from '@/lib/processingUploads'
import { desktopBridge, desktopProductToProduct } from '@/lib/desktopBridge'
import { mirrorProductToDesktop, productApi, requestDesktopSync } from '@/features/products/productApi'
import { pricingApi } from '@/features/admin/pricingApi'
import { useAuthStore } from '@/stores/authStore'
import type { Product, ProductFormData } from '@/types/product'
import {
  buildSupplierProductMatchIndex,
  desktopProductsWithBarcodes,
  matchSupplierImportRow,
  normalizeSupplierBarcode,
  type SupplierImportRow,
  type SupplierProductMatch,
  type SupplierProductMatchCandidate,
} from './supplierImportLocal'

export interface SupplierPriceImport {
  id: string
  tenant_id: string
  supplier_id: string | null
  filename: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  total_rows: number
  processed_rows: number
  errors_log: Array<{ row: number; error: string; raw?: string }>
  created_at: string
  updated_at: string
  suppliers?: { id: string; name: string }
}

export interface SupplierCatalogItem {
  id: string
  sku: string
  barcode?: string | null
  brand: string | null
  name: string
  price_kopecks: number
  qty: string
  warehouse_name: string | null
  supplier_id?: string | null
  matched_product_id?: string | null
  match_kind?: 'barcode' | 'sku' | 'name' | null
  match_error?: string | null
  updated_at?: string
  supplier?: { id: string; name: string }
}

export interface SupplierCatalogItemInput {
  sku: string
  barcode?: string | null
  brand?: string
  name: string
  price_kopecks: number
  qty?: string
  warehouse_name?: string
  supplier_id?: string | null
}

export interface SupplierImportRowsOptions {
  supplierId: string | null
  supplierName?: string | null
  mode: 'replace' | 'add'
  warehouseName?: string
  parseErrors?: Array<{ row: number; error: string; raw?: string }>
}

export interface SupplierImportPreviewMatch {
  row: SupplierImportRow
  match: SupplierProductMatch
}

function currentTenantId(): string {
  const user = useAuthStore.getState().session?.user as any
  return user?.app_metadata?.tenant_id ?? user?.tenant_id ?? 'local'
}

function localSupplierCatalogBridge() {
  return desktopBridge()?.supplierCatalog ?? null
}

function isDesktopCatalog(): boolean {
  return Boolean(localSupplierCatalogBridge()?.list && desktopBridge()?.catalog.listProducts)
}

async function loadDesktopProductCandidates(): Promise<SupplierProductMatchCandidate[]> {
  const catalog = desktopBridge()?.catalog
  if (!catalog?.listProducts) return []
  const products = []
  let offset = 0
  const limit = 500
  let total = Number.POSITIVE_INFINITY
  while (offset < total) {
    const page = await catalog.listProducts({ limit, offset, sortField: 'name', sortDir: 'asc' })
    products.push(...page.data)
    total = page.total
    if (page.data.length === 0) break
    offset += page.data.length
  }
  const barcodes = await catalog.listProductBarcodes?.() ?? []
  return desktopProductsWithBarcodes(products, barcodes)
}

async function previewDesktopMatches(rows: SupplierImportRow[]): Promise<SupplierImportPreviewMatch[]> {
  if (!isDesktopCatalog()) return rows.map((row) => ({ row, match: { product: null, kind: null, error: null } }))
  const index = buildSupplierProductMatchIndex(await loadDesktopProductCandidates())
  return rows.map((row) => ({ row, match: matchSupplierImportRow(row, index) }))
}


function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function mappedRowsToServerFile(filename: string, rows: SupplierImportRow[]): File {
  const header = ['Артикул', 'Штрихкод', 'Назва', 'Кількість', 'Ціна', 'Бренд']
  const lines = rows.map((row) => [
    row.sku,
    row.barcode,
    row.name,
    row.qty,
    (row.price_kopecks / 100).toFixed(2),
    row.brand,
  ].map(csvCell).join(';'))
  const csv = `\uFEFF${header.join(';')}\r\n${lines.join('\r\n')}`
  return new File([csv], filename.replace(/\.(xlsx?|csv)$/i, '') + '.csv', { type: 'text/csv;charset=utf-8' })
}

async function uploadServerFile(file: File, options: SupplierImportRowsOptions) {
  const uploaded = await uploadProcessingBlob(file, 'supplier-import')
  try {
    return await request<{ success: boolean; importId: string }>('/api/v1/supplier-imports/upload-from-storage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storage_path: uploaded.path,
        filename: file.name,
        supplier_id: options.supplierId,
        mode: options.mode,
        warehouse_name: options.warehouseName,
      }),
    })
  } finally {
    await removeProcessingUploads([uploaded.path]).catch(() => {})
  }
}

async function uploadLocalRows(filename: string, rows: SupplierImportRow[], options: SupplierImportRowsOptions) {
  const bridge = localSupplierCatalogBridge()
  if (!bridge) throw new Error('Локальний каталог постачальника недоступний')
  const result = await bridge.importRows(filename, rows, {
    tenant_id: currentTenantId(),
    supplier_id: options.supplierId,
    supplier_name: options.supplierName ?? null,
    mode: options.mode,
    warehouse_name: options.warehouseName?.trim() || null,
    parse_errors: options.parseErrors ?? [],
  })
  requestDesktopSync()
  return result
}
async function findExactDesktopProduct(input: { sku: string; barcode?: string | null; name: string }): Promise<Product | null> {
  const matches = await previewDesktopMatches([{
    source_row: 1,
    sku: input.sku,
    barcode: input.barcode ?? '',
    brand: '',
    name: input.name,
    qty: '0',
    price_kopecks: 0,
  }])
  const match = matches[0]?.match
  if (match?.error) throw new Error(match.error)
  if (!match?.product) return null
  const local = await desktopBridge()?.catalog.findById?.(match.product.id)
  return local ? desktopProductToProduct(local) : null
}

export const supplierImportsApi = {
  isLocal: isDesktopCatalog,
  previewRows: previewDesktopMatches,

  uploadRows: async (filename: string, rows: SupplierImportRow[], options: SupplierImportRowsOptions) => {
    if (isDesktopCatalog()) return uploadLocalRows(filename, rows, options)
    return uploadServerFile(mappedRowsToServerFile(filename, rows), options)
  },

  getStatus: async (id: string) => {
    if (isDesktopCatalog()) {
      const bridge = localSupplierCatalogBridge()
      if (!bridge) throw new Error('Локальний каталог постачальника недоступний')
      const data = await bridge.getImport(id, currentTenantId()) as SupplierPriceImport | null
      if (!data) throw new Error('Імпорт не знайдено в локальній базі')
      return { data }
    }
    return request<{ data: SupplierPriceImport }>('/api/v1/supplier-imports/status/' + id)
  },

  list: async () => {
    if (isDesktopCatalog()) {
      const bridge = localSupplierCatalogBridge()
      if (!bridge) throw new Error('Локальний каталог постачальника недоступний')
      return { data: await bridge.listImports(currentTenantId(), 50) as SupplierPriceImport[] }
    }
    return request<{ data: SupplierPriceImport[] }>('/api/v1/supplier-imports')
  },

  createCatalogItem: async (body: SupplierCatalogItemInput) => {
    if (isDesktopCatalog()) {
      const bridge = localSupplierCatalogBridge()
      if (!bridge) throw new Error('Локальний каталог постачальника недоступний')
      const data = await bridge.create({ ...body, tenant_id: currentTenantId() }) as SupplierCatalogItem
      requestDesktopSync()
      return { data }
    }
    return request<{ data: SupplierCatalogItem }>('/api/v1/search/catalog', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
  },

  updateCatalogItem: async (id: string, body: Partial<SupplierCatalogItem> & { supplier_id?: string | null }) => {
    if (isDesktopCatalog()) {
      const bridge = localSupplierCatalogBridge()
      if (!bridge) throw new Error('Локальний каталог постачальника недоступний')
      const data = await bridge.update(id, body, currentTenantId()) as SupplierCatalogItem
      requestDesktopSync()
      return { data }
    }
    return request<{ data: SupplierCatalogItem }>('/api/v1/search/catalog/' + id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
  },

  deleteCatalogItem: async (id: string) => {
    if (isDesktopCatalog()) {
      const bridge = localSupplierCatalogBridge()
      if (!bridge) throw new Error('Локальний каталог постачальника недоступний')
      await bridge.delete(id, currentTenantId())
      requestDesktopSync()
      return undefined
    }
    return request<void>('/api/v1/search/catalog/' + id, { method: 'DELETE' })
  },

  getCatalog: async (params: { q?: string; supplier_id?: string; page?: number; limit?: number }) => {
    if (isDesktopCatalog()) {
      const bridge = localSupplierCatalogBridge()
      if (!bridge) throw new Error('Локальний каталог постачальника недоступний')
      return bridge.list({
        tenant_id: currentTenantId(),
        query: params.q,
        supplier_id: params.supplier_id,
        page: params.page,
        limit: params.limit,
      }) as Promise<{ data: SupplierCatalogItem[]; pagination: { page: number; limit: number; total: number } }>
    }
    const query = new URLSearchParams()
    if (params.q) query.append('q', params.q)
    if (params.supplier_id) query.append('supplier_id', params.supplier_id)
    if (params.page) query.append('page', String(params.page))
    if (params.limit) query.append('limit', String(params.limit))
    return request<{ data: SupplierCatalogItem[]; pagination: { page: number; limit: number; total: number } }>(
      '/api/v1/search/catalog?' + query.toString(),
    )
  },

  importOnDemand: async (input: {
    sku: string
    barcode?: string | null
    brand: string
    name: string
    supplier_id: string | null
    purchase_price: number
    retail_price?: number
  }) => {
    if (isDesktopCatalog()) {
      const existing = await findExactDesktopProduct(input)
      if (existing) return { data: existing, reused: true }
      const generatedSku = input.sku.trim() || `AUTO-${crypto.randomUUID().replace(/-/g, '').toUpperCase()}`
      let retailPrice = input.retail_price
      if (retailPrice == null) {
        retailPrice = await pricingApi.autoRetail(input.purchase_price)
          .then((result) => result.data.retail_price ?? input.purchase_price)
          .catch(() => input.purchase_price)
      }
      const form: ProductFormData = {
        sku: generatedSku,
        name: input.name.trim(),
        barcode: normalizeSupplierBarcode(input.barcode),
        brand_id: '',
        category_id: '',
        unit: 'шт',
        purchase_price: (Math.max(0, input.purchase_price) / 100).toFixed(2),
        retail_price: (Math.max(0, retailPrice) / 100).toFixed(2),
        qty_on_hand: '0',
        reorder_point: '0',
        notes: input.supplier_id ? 'Імпортовано з прайсу постачальника' : '',
        is_active: true,
        storage_bin: '',
        is_favorite: false,
        specs: {},
      }
      const response = await productApi.create(form, { silent: true, reuseExistingSku: true })
      requestDesktopSync()
      return { data: response.data, reused: false }
    }

    const response = await request<{ data: Product }>('/api/v1/search/import-on-demand', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    })
    if (response.data) {
      await mirrorProductToDesktop(response.data)
      requestDesktopSync()
    }
    return response
  },
}
