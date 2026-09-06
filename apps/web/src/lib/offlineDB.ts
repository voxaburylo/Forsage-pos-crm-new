/**
 * IndexedDB обгортка для офлайн-режиму POS
 *
 * Stores:
 *   products      — кеш каталогу товарів (оновлюється кожні 30 хв)
 *   categories    — кеш категорій для пошуку
 *   pending_sales — transactional outbox продажів
 *   sales         — локальна історія чеків (pending + synced + remote)
 *   brands        — локальний довідник брендів
 *   sync_log      — журнал останніх синхронізацій/помилок
 *   meta          — час кешування та остання відкрита зміна
 *
 * УВАГА: це черга ТІЛЬКИ для браузерної версії. На касі (Electron) працює
 * власна черга в SQLite, і чек, покладений сюди, не потрапив би на сервер
 * ніколи — його б ніхто не читав. Тому записи в чергу продажів на касі
 * падають з помилкою, а не тихо спрацьовують: краще гучна відмова, яку
 * касир побачить одразу, ніж зниклий чек, який знайдеться через місяць.
 */
import { isDesktopRuntime } from './desktopBridge'
import { catalogComparator } from './catalogOrder'

/** Одна перевірка на всі входи в чергу продажів — щоб не покладатися на памʼять. */
function assertBrowserQueueUsable(action: string): void {
  if (!isDesktopRuntime()) return
  throw new Error(
    `Черга браузера недоступна на касі (${action}): у каси власна локальна база. `
    + 'Чек треба зберігати через неї, інакше він не потрапить на сервер.',
  )
}

const DB_NAME    = 'forsage_offline'
const DB_VERSION = 7
let dbPromise: Promise<IDBDatabase> | null = null

function normalizeOfflineProductSearchText(value: unknown): string {
  return String(value ?? '')
    .toLocaleLowerCase('uk-UA')
    .replace(/ё/g, 'е')
    .replace(/ґ/g, 'г')
    .replace(/ї/g, 'и')
    .replace(/і/g, 'и')
    .replace(/є/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim()
}

function offlineProductSearchNeedles(raw: string): string[] {
  const values = new Set<string>()
  const normalized = normalizeOfflineProductSearchText(raw)
  if (normalized) values.add(normalized)
  const replacements: Array<[RegExp, string]> = [
    [/\bbooster\b/gi, 'бустер'],
    [/\bboost\b/gi, 'бустер'],
    [/\bwires?\b/gi, 'провода'],
    [/бустер/gi, 'booster'],
    [/провод/gi, 'wire'],
  ]
  for (const [pattern, replacement] of replacements) {
    const variant = normalizeOfflineProductSearchText(raw.replace(pattern, replacement))
    if (variant) values.add(variant)
  }
  return [...values]
}

function offlineProductSearchTokens(raw: string): string[] {
  const tokens = new Set<string>()
  for (const needle of offlineProductSearchNeedles(raw)) {
    for (const token of needle.split(/\s+/)) {
      if (token.length >= 2) tokens.add(token)
    }
  }
  return [...tokens]
}

function compactOfflineLookupCode(raw: string): string {
  return raw.replace(/[\s\-._/]+/g, '').trim().toLocaleLowerCase('uk-UA')
}

export function offlineProductMatchesQuery(product: any, rawQuery: string): boolean {
  const query = String(rawQuery ?? '').trim()
  if (!query) return true
  const queryLower = query.toLocaleLowerCase('uk-UA')
  const compactQuery = compactOfflineLookupCode(query)
  const barcodes = [product.barcode, ...(Array.isArray(product.additional_barcodes) ? product.additional_barcodes : [])]
    .filter(Boolean)
    .map((value) => String(value))
  const referenceValues = [
    ...barcodes,
    ...(Array.isArray(product.aliases) ? product.aliases : []),
    ...(Array.isArray(product.cross_numbers) ? product.cross_numbers : []),
  ].filter(Boolean).map((value) => String(value))
  const sku = String(product.sku ?? '')
  const compactSku = compactOfflineLookupCode(sku)
  if (compactSku && compactSku.includes(compactQuery)) return true
  if (referenceValues.some((barcode) => {
    const value = String(barcode).toLocaleLowerCase('uk-UA')
    return value === queryLower || compactOfflineLookupCode(value).includes(compactQuery)
  })) return true
  const searchText = normalizeOfflineProductSearchText([
    product.name,
    product.sku,
    product.barcode,
    product.storage_bin,
    ...(Array.isArray(product.additional_barcodes) ? product.additional_barcodes : []),
    ...(Array.isArray(product.aliases) ? product.aliases : []),
    ...(Array.isArray(product.cross_numbers) ? product.cross_numbers : []),
  ].filter(Boolean).join(' '))
  if (!searchText) return false
  const needles = offlineProductSearchNeedles(query)
  if (needles.some((needle) => searchText.includes(needle))) return true
  const tokens = offlineProductSearchTokens(query)
  return tokens.length > 0 && tokens.every((token) => searchText.includes(token))
}

export async function ensurePersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  if (await navigator.storage.persisted()) return true
  return navigator.storage.persist()
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result

      if (!db.objectStoreNames.contains('products')) {
        const store = db.createObjectStore('products', { keyPath: 'id' })
        store.createIndex('by_sku',  'sku',     { unique: false })
        store.createIndex('by_name', 'name',    { unique: false })
        store.createIndex('by_barcode', 'barcode', { unique: false })
        store.createIndex('by_additional_barcode', 'additional_barcodes', { unique: false, multiEntry: true })
      } else {
        const store = req.transaction!.objectStore('products')
        if (!store.indexNames.contains('by_sku')) store.createIndex('by_sku', 'sku', { unique: false })
        if (!store.indexNames.contains('by_name')) store.createIndex('by_name', 'name', { unique: false })
        if (!store.indexNames.contains('by_barcode')) store.createIndex('by_barcode', 'barcode', { unique: false })
        if (!store.indexNames.contains('by_additional_barcode')) {
          store.createIndex('by_additional_barcode', 'additional_barcodes', { unique: false, multiEntry: true })
        }
      }

      if (!db.objectStoreNames.contains('pending_sales')) {
        const store = db.createObjectStore('pending_sales', { keyPath: 'offline_id' })
        store.createIndex('by_created', 'created_at', { unique: false })
        store.createIndex('by_status', 'sync_status', { unique: false })
        store.createIndex('by_scope', 'scope_key', { unique: false })
      } else {
        const store = req.transaction!.objectStore('pending_sales')
        if (!store.indexNames.contains('by_status')) {
          store.createIndex('by_status', 'sync_status', { unique: false })
        }
        if (!store.indexNames.contains('by_scope')) {
          store.createIndex('by_scope', 'scope_key', { unique: false })
        }
      }

      if (!db.objectStoreNames.contains('categories')) {
        db.createObjectStore('categories', { keyPath: 'id' })
      }

      if (!db.objectStoreNames.contains('staff')) {
        db.createObjectStore('staff', { keyPath: 'id' })
      }

      if (!db.objectStoreNames.contains('customers')) {
        const store = db.createObjectStore('customers', { keyPath: 'id' })
        store.createIndex('by_phone', 'phone', { unique: false })
      }

      if (!db.objectStoreNames.contains('sales')) {
        const store = db.createObjectStore('sales', { keyPath: 'local_id' })
        store.createIndex('by_server_id', 'server_id', { unique: false })
        store.createIndex('by_completed_at', 'completed_at', { unique: false })
        store.createIndex('by_sync_status', 'sync_status', { unique: false })
        store.createIndex('by_customer', 'customer_id', { unique: false })
        store.createIndex('by_scope', 'scope_key', { unique: false })
      } else {
        const store = req.transaction!.objectStore('sales')
        if (!store.indexNames.contains('by_scope')) {
          store.createIndex('by_scope', 'scope_key', { unique: false })
        }
      }
      if (!db.objectStoreNames.contains('brands')) {
        db.createObjectStore('brands', { keyPath: 'id' })
      }

      if (!db.objectStoreNames.contains('sync_log')) {
        const store = db.createObjectStore('sync_log', { keyPath: 'id', autoIncrement: true })
        store.createIndex('by_created_at', 'created_at', { unique: false })
      }

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' })
      }
    }

    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => {
      dbPromise = null
      reject(req.error)
    }
  })
  return dbPromise
}

// ─── Products cache ───────────────────────────────────────────────────────────

export async function cacheProducts(products: any[], scopeKey: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(['products', 'meta'], 'readwrite')
    const store = tx.objectStore('products')

    // Очищаємо і перезаписуємо
    store.clear()
    for (const p of products) store.put(p)

    tx.objectStore('meta').put({ key: 'products_cached_at', value: Date.now() })
    tx.objectStore('meta').put({ key: 'cache_scope', value: scopeKey })
    tx.oncomplete = () => {
      window.dispatchEvent(new CustomEvent('forsage:offline-products-refreshed'))
      resolve()
    }
    tx.onerror    = () => reject(tx.error)
  })
}

export async function searchProductsOffline(
  query: string,
  limit = 20,
  scopeKey?: string,
  categoryName?: string | null,
): Promise<any[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(['products', 'meta'], 'readonly')
    const store = tx.objectStore('products')
    const scopeRequest = tx.objectStore('meta').get('cache_scope')
    const req   = store.getAll()

    req.onsuccess = () => {
      if (scopeKey && scopeRequest.result?.value !== scopeKey) {
        resolve([])
        return
      }
      const rawQuery = query.trim()
      const results = (req.result as any[])
        .filter((p) => {
          if (p.deleted_at || p.is_active === false || p.is_active === 0 || (categoryName && p.category?.name !== categoryName)) return false
          return offlineProductMatchesQuery(p, rawQuery)
        })
        .sort(catalogComparator({ search: rawQuery }))
        .slice(0, limit)
      resolve(results)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function findProductByScanOffline(
  code: string,
  scopeKey?: string,
): Promise<any | null> {
  const db = await openDB()
  const normalizedSku = code.replace(/[\s\-./_]/g, '').toUpperCase()

  const indexed = await new Promise<any | null>((resolve, reject) => {
    const tx = db.transaction(['products', 'meta'], 'readonly')
    const store = tx.objectStore('products')
    const scopeRequest = tx.objectStore('meta').get('cache_scope')
    const candidates: any[] = []

    if (store.indexNames.contains('by_barcode')) {
      const barcodeRequest = store.index('by_barcode').get(code)
      barcodeRequest.onsuccess = () => { if (barcodeRequest.result) candidates.push(barcodeRequest.result) }
    }
    if (store.indexNames.contains('by_additional_barcode')) {
      const additionalRequest = store.index('by_additional_barcode').get(code)
      additionalRequest.onsuccess = () => { if (additionalRequest.result) candidates.push(additionalRequest.result) }
    }
    if (store.indexNames.contains('by_sku')) {
      for (const sku of [...new Set([code, code.toUpperCase(), normalizedSku])]) {
        const skuRequest = store.index('by_sku').get(sku)
        skuRequest.onsuccess = () => { if (skuRequest.result) candidates.push(skuRequest.result) }
      }
    }

    tx.oncomplete = () => {
      if (scopeKey && scopeRequest.result?.value !== scopeKey) {
        resolve(null)
        return
      }
      resolve(candidates.find((product) => product.is_active !== false) ?? null)
    }
    tx.onerror = () => reject(tx.error)
  })

  if (indexed) return indexed
  // Ніколи не робимо getAll() по всьому каталогу в критичному шляху сканера.
  // Усі види штрихкодів мають IndexedDB-індекси; невідомий код одразу піде
  // в точний серверний endpoint.
  return null
}

export async function getCachedProductsForScan(scopeKey?: string): Promise<any[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['products', 'meta'], 'readonly')
    const scopeRequest = tx.objectStore('meta').get('cache_scope')
    const productsRequest = tx.objectStore('products').getAll()
    productsRequest.onsuccess = () => {
      if (scopeKey && scopeRequest.result?.value !== scopeKey) {
        resolve([])
        return
      }
      resolve((productsRequest.result ?? []).filter((product: any) => product.is_active !== false))
    }
    productsRequest.onerror = () => reject(productsRequest.error)
  })
}

export async function getProductsCacheAge(): Promise<number | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('meta', 'readonly')
    const req = tx.objectStore('meta').get('products_cached_at')
    req.onsuccess = () => resolve(req.result?.value ?? null)
    req.onerror   = () => reject(req.error)
  })
}

export async function getProductsCacheScope(): Promise<string | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly')
    const req = tx.objectStore('meta').get('cache_scope')
    req.onsuccess = () => resolve(req.result?.value ?? null)
    req.onerror = () => reject(req.error)
  })
}

export async function getCachedProductsByIds(ids: string[]): Promise<any[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('products', 'readonly')
    const store = tx.objectStore('products')
    const results: any[] = []
    for (const id of [...new Set(ids)]) {
      const req = store.get(id)
      req.onsuccess = () => { if (req.result) results.push(req.result) }
    }
    tx.oncomplete = () => resolve(results)
    tx.onerror = () => reject(tx.error)
  })
}

export async function cacheCategories(categories: any[], scopeKey: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['categories', 'meta'], 'readwrite')
    const store = tx.objectStore('categories')
    store.clear()
    for (const category of categories) store.put(category)
    tx.objectStore('meta').put({ key: 'cache_scope', value: scopeKey })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getCachedCategories(scopeKey?: string): Promise<any[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['categories', 'meta'], 'readonly')
    const scopeRequest = tx.objectStore('meta').get('cache_scope')
    const req = tx.objectStore('categories').getAll()
    req.onsuccess = () => {
      if (scopeKey && scopeRequest.result?.value !== scopeKey) resolve([])
      else resolve(req.result ?? [])
    }
    req.onerror = () => reject(req.error)
  })
}

export async function cacheStaff(staff: any[], scopeKey: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['staff', 'meta'], 'readwrite')
    const store = tx.objectStore('staff')
    store.clear()
    for (const person of staff) store.put(person)
    tx.objectStore('meta').put({ key: 'cache_scope', value: scopeKey })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getCachedStaff(scopeKey?: string): Promise<any[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['staff', 'meta'], 'readonly')
    const scopeRequest = tx.objectStore('meta').get('cache_scope')
    const req = tx.objectStore('staff').getAll()
    req.onsuccess = () => {
      if (scopeKey && scopeRequest.result?.value !== scopeKey) resolve([])
      else resolve(req.result ?? [])
    }
    req.onerror = () => reject(req.error)
  })
}

export async function cacheCustomers(customers: any[], scopeKey: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['customers', 'meta'], 'readwrite')
    const store = tx.objectStore('customers')
    store.clear()
    for (const customer of customers) store.put(customer)
    tx.objectStore('meta').put({ key: 'cache_scope', value: scopeKey })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function searchCustomersOffline(
  query: string,
  limit = 10,
  scopeKey?: string,
): Promise<any[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['customers', 'meta'], 'readonly')
    const scopeRequest = tx.objectStore('meta').get('cache_scope')
    const req = tx.objectStore('customers').getAll()
    req.onsuccess = () => {
      if (scopeKey && scopeRequest.result?.value !== scopeKey) {
        resolve([])
        return
      }
      const normalized = query.toLocaleLowerCase('uk-UA').replace(/\s+/g, '')
      const digits = query.replace(/\D/g, '')
      resolve((req.result ?? []).filter((customer: any) => {
        const name = String(customer.full_name ?? '').toLocaleLowerCase('uk-UA').replace(/\s+/g, '')
        const phone = String(customer.phone ?? '').replace(/\D/g, '')
        const vin = String(customer.primary_vin ?? '').toLocaleLowerCase('uk-UA')
        const barcode = String(customer.card_barcode ?? '')
        return name.includes(normalized)
          || (!!digits && phone.includes(digits))
          || vin.includes(normalized)
          || barcode === query
      }).slice(0, limit))
    }
    req.onerror = () => reject(req.error)
  })
}

export async function listCustomersOffline(options: {
  search?: string
  hasDebt?: boolean
  page?: number
  perPage?: number
  scopeKey?: string
} = {}): Promise<{ data: any[]; pagination: { page: number; per_page: number; total: number; total_pages: number } }> {
  const db = await openDB()
  const all = await new Promise<any[]>((resolve, reject) => {
    const tx = db.transaction(['customers', 'meta'], 'readonly')
    const scopeRequest = tx.objectStore('meta').get('cache_scope')
    const req = tx.objectStore('customers').getAll()
    req.onsuccess = () => {
      if (options.scopeKey && scopeRequest.result?.value !== options.scopeKey) resolve([])
      else resolve(req.result ?? [])
    }
    req.onerror = () => reject(req.error)
  })

  const query = String(options.search ?? '').toLocaleLowerCase('uk-UA').trim()
  const digits = query.replace(/\D/g, '')
  const filtered = all
    .filter((customer) => {
      if (options.hasDebt && Number(customer.debt_balance ?? 0) <= 0) return false
      if (!query) return true
      const name = String(customer.full_name ?? '').toLocaleLowerCase('uk-UA')
      const phone = String(customer.phone ?? '').replace(/\D/g, '')
      const vin = String(customer.primary_vin ?? '').toLocaleLowerCase('uk-UA')
      const barcode = String(customer.card_barcode ?? '').toLocaleLowerCase('uk-UA')
      return name.includes(query)
        || (!!digits && phone.includes(digits))
        || vin.includes(query)
        || barcode.includes(query)
    })
    .sort((a, b) => options.hasDebt
      ? Number(b.debt_balance ?? 0) - Number(a.debt_balance ?? 0)
      : String(a.full_name ?? a.phone ?? '').localeCompare(String(b.full_name ?? b.phone ?? ''), 'uk'))

  const page = Math.max(1, options.page ?? 1)
  const perPage = Math.max(1, options.perPage ?? 50)
  const total = filtered.length
  return {
    data: filtered.slice((page - 1) * perPage, page * perPage),
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
    },
  }
}

export async function decrementCachedStock(
  items: Array<{ product_id: string; qty: number }>,
): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('products', 'readwrite')
    const store = tx.objectStore('products')
    for (const item of items) {
      const req = store.get(item.product_id)
      req.onsuccess = () => {
        const product = req.result
        if (!product || product.is_service) return
        store.put({
          ...product,
          qty_on_hand: Math.max(0, Number(product.qty_on_hand ?? 0) - item.qty),
          qty_available: Math.max(
            0,
            Number(product.qty_available ?? product.qty_on_hand ?? 0) - item.qty,
          ),
        })
      }
    }
    tx.oncomplete = () => {
      window.dispatchEvent(new CustomEvent('forsage:offline-stock-updated'))
      resolve()
    }
    tx.onerror = () => reject(tx.error)
  })
}

export async function cacheCurrentShift(shift: any, scopeKey: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite')
    tx.objectStore('meta').put({
      key: 'current_shift',
      value: shift ? { shift, scopeKey, cachedAt: Date.now() } : null,
    })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getCachedCurrentShift(scopeKey: string): Promise<any | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly')
    const req = tx.objectStore('meta').get('current_shift')
    req.onsuccess = () => {
      const cached = req.result?.value
      resolve(cached?.scopeKey === scopeKey && cached?.shift?.status === 'open' ? cached.shift : null)
    }
    req.onerror = () => reject(req.error)
  })
}

// ─── Pending sales queue ──────────────────────────────────────────────────────

export interface PendingSale {
  offline_id:     string   // crypto.randomUUID()
  scope_key:      string
  created_at:     string   // ISO
  shift_id:       string
  customer_id:    string | null
  manager_id:     string | null
  customer_order_id: string | null
  items:          Array<{ product_id: string; qty: number; unit_price: number; discount: number }>
  payment_method: 'cash' | 'transfer'
  total:          number
  notes:          string | null
  is_fiscal:      false
  terminal_auth_code: null
  discount:       number
  bonuses_spent:  0
  cash_amount:    number
  card_amount:    0
  idempotency_key: string
  sync_status:    'pending' | 'failed'
  sync_attempts:  number
  last_error:     string | null
  receipt_items?: Array<{
    product_id: string
    sku: string
    name: string
    unit: string
  }>
  customer_snapshot?: { phone: string; full_name: string | null } | null
}

export interface LocalSaleRecord {
  local_id: string
  scope_key: string
  server_id: string | null
  sync_status: 'pending' | 'failed' | 'synced' | 'remote'
  sync_error: string | null
  synced_at: string | null
  id: string
  sale_number: string
  customer_id: string | null
  cashier_id: string
  manager_id: string | null
  shift_id: string
  status: string
  subtotal: number
  discount: number
  total: number
  payment_method: string
  is_debt: boolean
  notes: string | null
  completed_at: string
  is_fiscal: boolean
  fiscal_number: string | null
  bank_auth_code: string | null
  cash_amount: number
  card_amount: number
  pickup_cell: string | null
  sale_items?: any[]
  customer?: any
}

export interface SyncChanges {
  tenant_id?: string
  cursor: string
  reset_required?: boolean
  reset_generation?: number
  reset_at?: string | null
  products: any[]
  deleted_product_ids: string[]
  customers: any[]
  deleted_customer_ids: string[]
  suppliers?: any[]
  deleted_supplier_ids?: string[]
  sales: any[]
  categories: any[]
  brands: any[]
  product_barcodes?: any[]
  deleted_product_barcode_ids?: string[]
  product_aliases?: any[]
  deleted_product_alias_ids?: string[]
  product_cross_numbers?: any[]
  deleted_product_cross_number_ids?: string[]
  customer_vehicles?: any[]
  deleted_customer_vehicle_ids?: string[]
  deleted_category_ids?: string[]
  deleted_brand_ids?: string[]
  references_included: boolean
}

function uniqueReferenceValues(values: unknown[]): string[] {
  return [...new Set(values
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))]
}

export function attachProductReferences(
  products: any[],
  productBarcodes: any[] = [],
  productAliases: any[] = [],
  productCrossNumbers: any[] = [],
): any[] {
  const barcodesByProduct = new Map<string, string[]>()
  const aliasesByProduct = new Map<string, string[]>()
  const crossNumbersByProduct = new Map<string, string[]>()

  for (const row of productBarcodes) {
    if (!row?.product_id || !row?.barcode) continue
    const values = barcodesByProduct.get(row.product_id) ?? []
    values.push(String(row.barcode))
    barcodesByProduct.set(row.product_id, values)
  }
  for (const row of productAliases) {
    if (!row?.product_id || !row?.alias) continue
    const values = aliasesByProduct.get(row.product_id) ?? []
    values.push(String(row.alias))
    aliasesByProduct.set(row.product_id, values)
  }
  for (const row of productCrossNumbers) {
    if (!row?.product_id || !row?.number) continue
    const values = crossNumbersByProduct.get(row.product_id) ?? []
    values.push(String(row.number))
    crossNumbersByProduct.set(row.product_id, values)
  }

  return products.map((product) => ({
    ...product,
    additional_barcodes: uniqueReferenceValues([
      ...(Array.isArray(product.additional_barcodes) ? product.additional_barcodes : []),
      ...(barcodesByProduct.get(product.id) ?? []),
    ]).filter((barcode) => barcode !== String(product.barcode ?? '').trim()),
    aliases: uniqueReferenceValues([
      ...(Array.isArray(product.aliases) ? product.aliases : []),
      ...(aliasesByProduct.get(product.id) ?? []),
    ]),
    cross_numbers: uniqueReferenceValues([
      ...(Array.isArray(product.cross_numbers) ? product.cross_numbers : []),
      ...(crossNumbersByProduct.get(product.id) ?? []),
    ]),
  }))
}

export interface LocalSyncState {
  cursor: string | null
  last_success_at: number | null
  reset_generation: number
  last_attempt_at: number | null
  last_error: string | null
  last_reference_sync_at: number | null
  snapshot_in_progress?: boolean
}

function syncMetaKey(scopeKey: string): string {
  return `sync_state:${scopeKey}`
}

export async function getLocalSyncState(scopeKey: string): Promise<LocalSyncState> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly')
    const req = tx.objectStore('meta').get(syncMetaKey(scopeKey))
    req.onsuccess = () => {
      const stored = req.result?.value as Partial<LocalSyncState> | undefined
      resolve({
      cursor: null,
      last_success_at: null,
      last_attempt_at: null,
      last_error: null,
      last_reference_sync_at: null,
      snapshot_in_progress: false,
        ...stored,
        reset_generation: Number(stored?.reset_generation ?? 0),
      })
    }
    req.onerror = () => reject(req.error)
  })
}

export async function getCachedBrands(scopeKey?: string): Promise<any[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['brands', 'meta'], 'readonly')
    const scopeRequest = tx.objectStore('meta').get('cache_scope')
    const req = tx.objectStore('brands').getAll()
    req.onsuccess = () => {
      if (scopeKey && scopeRequest.result?.value !== scopeKey) resolve([])
      else resolve(req.result ?? [])
    }
    req.onerror = () => reject(req.error)
  })
}

export async function listProductsOffline(options: {
  search?: string
  categoryId?: string
  brandId?: string
  lowStock?: boolean
  stockFilter?: 'negative' | 'no_price' | ''
  page?: number
  perPage?: number
  sortField?: string
  sortDir?: 'asc' | 'desc'
  scopeKey?: string
} = {}): Promise<{ data: any[]; pagination: { page: number; per_page: number; total: number; total_pages: number } }> {
  const db = await openDB()
  const all = await new Promise<any[]>((resolve, reject) => {
    const tx = db.transaction(['products', 'meta'], 'readonly')
    const scopeReq = tx.objectStore('meta').get('cache_scope')
    const req = tx.objectStore('products').getAll()
    req.onsuccess = () => {
      if (options.scopeKey && scopeReq.result?.value !== options.scopeKey) resolve([])
      else resolve(req.result ?? [])
    }
    req.onerror = () => reject(req.error)
  })

  const search = String(options.search ?? '').trim()
  const filtered = all.filter((product) => {
    if (product.deleted_at || product.is_active === false || product.is_active === 0) return false
    if (options.categoryId === '__uncategorized') {
      if (product.category_id) return false
    } else if (options.categoryId && product.category_id !== options.categoryId) return false
    if (options.brandId && product.brand_id !== options.brandId) return false
    if (options.lowStock && Number(product.qty_on_hand ?? 0) > Number(product.reorder_point ?? 0)) return false
    if (options.stockFilter === 'negative' && Number(product.qty_on_hand ?? 0) >= 0) return false
    if (options.stockFilter === 'no_price' && Number(product.retail_price ?? 0) !== 0) return false
    return offlineProductMatchesQuery(product, search)
  })

  filtered.sort(catalogComparator(options))
  const page = Math.max(1, options.page ?? 1)
  const perPage = Math.max(1, options.perPage ?? 25)
  const total = filtered.length
  return {
    data: filtered.slice((page - 1) * perPage, page * perPage),
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
    },
  }
}

export async function markSyncAttempt(scopeKey: string): Promise<void> {
  const current = await getLocalSyncState(scopeKey)
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite')
    tx.objectStore('meta').put({
      key: syncMetaKey(scopeKey),
      value: { ...current, last_attempt_at: Date.now() },
    })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function markSyncError(scopeKey: string, error: string): Promise<void> {
  const current = await getLocalSyncState(scopeKey)
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['meta', 'sync_log'], 'readwrite')
    tx.objectStore('meta').put({
      key: syncMetaKey(scopeKey),
      value: { ...current, last_attempt_at: Date.now(), last_error: error.slice(0, 500) },
    })
    tx.objectStore('sync_log').add({
      created_at: new Date().toISOString(),
      level: 'error',
      message: error.slice(0, 500),
    })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function resetOfflineSyncData(
  changes: Pick<SyncChanges, 'reset_generation' | 'reset_at'>,
  scopeKey: string,
): Promise<void> {
  const db = await openDB()
  const now = Date.now()
  await new Promise<void>((resolve, reject) => {
    const stores = [
      'products',
      'categories',
      'brands',
      'customers',
      'staff',
      'sales',
      'pending_sales',
      'meta',
      'sync_log',
    ]
    const tx = db.transaction(stores, 'readwrite')
    for (const storeName of stores.slice(0, 5)) {
      tx.objectStore(storeName).clear()
    }
    for (const storeName of ['sales', 'pending_sales']) {
      const request = tx.objectStore(storeName).openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        if (cursor.value?.scope_key === scopeKey) cursor.delete()
        cursor.continue()
      }
    }
    const meta = tx.objectStore('meta')
    meta.delete('current_shift')
    meta.delete('products_cached_at')
    meta.delete('cache_scope')
    meta.put({
      key: syncMetaKey(scopeKey),
      value: {
        cursor: null,
        reset_generation: Number(changes.reset_generation ?? 0),
        last_success_at: null,
        last_attempt_at: now,
        last_error: null,
        last_reference_sync_at: null,
        snapshot_in_progress: false,
      } satisfies LocalSyncState,
    })
    const log = tx.objectStore('sync_log')
    log.clear()
    log.add({
      created_at: new Date().toISOString(),
      level: 'success',
      message: `server reset applied; generation=${Number(changes.reset_generation ?? 0)}`,
    })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB reset transaction aborted'))
  })
  window.dispatchEvent(new CustomEvent('forsage:offline-stock-updated'))
  window.dispatchEvent(new CustomEvent('forsage:offline-products-refreshed'))
}

export async function applySyncChanges(
  changes: SyncChanges,
  scopeKey: string,
  replaceSnapshot: boolean,
): Promise<void> {
  if (changes.reset_required === true) {
    await resetOfflineSyncData(changes, scopeKey)
    return
  }
  const pending = await getPendingSales(scopeKey)
  const previousSyncState = await getLocalSyncState(scopeKey)
  const pendingQty = new Map<string, number>()
  for (const sale of pending) {
    for (const item of sale.items) {
      pendingQty.set(item.product_id, (pendingQty.get(item.product_id) ?? 0) + Number(item.qty))
    }
  }

  const db = await openDB()
  const batchSize = 500
  const yieldToBrowser = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  const transact = (
    stores: string[],
    write: (tx: IDBTransaction) => void,
  ): Promise<void> => new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    try {
      write(tx)
    } catch (error) {
      try { tx.abort() } catch { /* transaction may already be inactive */ }
      reject(error)
    }
  })
  const readStoreKeys = (storeName: string): Promise<string[]> => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const request = tx.objectStore(storeName).getAllKeys()
    request.onsuccess = () => resolve((request.result ?? []).map(String))
    request.onerror = () => reject(request.error)
  })
  const writeBatches = async <T>(
    rows: T[],
    stores: string[],
    write: (tx: IDBTransaction, row: T) => void,
  ) => {
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize)
      await transact(stores, (tx) => {
        for (const row of batch) write(tx, row)
      })
      await yieldToBrowser()
    }
  }

  // Never clear a known-good cache before a replacement snapshot succeeds.
  // Incoming rows are persisted first; only then are keys missing from the
  // replacement pruned. A failed refresh therefore remains usable and retries.
  const snapshotKeyLists = replaceSnapshot
    ? await Promise.all([
        readStoreKeys('products'),
        readStoreKeys('customers'),
        changes.references_included ? readStoreKeys('categories') : Promise.resolve([]),
        changes.references_included ? readStoreKeys('brands') : Promise.resolve([]),
      ])
    : null
  const snapshotKeys = snapshotKeyLists
    ? {
        products: snapshotKeyLists[0],
        customers: snapshotKeyLists[1],
        categories: snapshotKeyLists[2],
        brands: snapshotKeyLists[3],
      }
    : null

  if (replaceSnapshot) {
    await transact(['meta'], (tx) => {
      tx.objectStore('meta').put({
        key: syncMetaKey(scopeKey),
        value: {
          ...previousSyncState,
          cursor: null,
          last_attempt_at: Date.now(),
          snapshot_in_progress: true,
        } satisfies LocalSyncState,
      })
    })
    await yieldToBrowser()
  }

  const productsWithReferences = changes.references_included
    ? attachProductReferences(
        changes.products ?? [],
        changes.product_barcodes,
        changes.product_aliases,
        changes.product_cross_numbers,
      )
    : changes.products ?? []

  await writeBatches(productsWithReferences, ['products'], (tx, product) => {
    const queuedQty = pendingQty.get(product.id) ?? 0
    tx.objectStore('products').put({
      ...product,
      qty_on_hand: product.is_service
        ? product.qty_on_hand
        : Math.max(0, Number(product.qty_on_hand ?? 0) - queuedQty),
      qty_available: product.is_service
        ? product.qty_available
        : Math.max(0, Number(product.qty_available ?? product.qty_on_hand ?? 0) - queuedQty),
    })
  })
  await writeBatches(changes.deleted_product_ids ?? [], ['products'], (tx, id) => {
    tx.objectStore('products').delete(id)
  })
  await writeBatches(changes.customers ?? [], ['customers'], (tx, customer) => {
    tx.objectStore('customers').put(customer)
  })
  await writeBatches(changes.deleted_customer_ids ?? [], ['customers'], (tx, id) => {
    tx.objectStore('customers').delete(id)
  })
  await writeBatches(changes.categories ?? [], ['categories'], (tx, category) => {
    tx.objectStore('categories').put(category)
  })
  await writeBatches(changes.deleted_category_ids ?? [], ['categories'], (tx, id) => {
    tx.objectStore('categories').delete(id)
  })
  await writeBatches(changes.brands ?? [], ['brands'], (tx, brand) => {
    tx.objectStore('brands').put(brand)
  })
  await writeBatches(changes.deleted_brand_ids ?? [], ['brands'], (tx, id) => {
    tx.objectStore('brands').delete(id)
  })

  if (snapshotKeys) {
    const staleKeys = (existing: string[], incomingRows: any[]) => {
      const incoming = new Set(incomingRows
        .map((row) => String(row?.id ?? ''))
        .filter(Boolean))
      return existing.filter((id) => !incoming.has(id))
    }
    await writeBatches(staleKeys(snapshotKeys.products, changes.products ?? []), ['products'], (tx, id) => {
      tx.objectStore('products').delete(id)
    })
    await writeBatches(staleKeys(snapshotKeys.customers, changes.customers ?? []), ['customers'], (tx, id) => {
      tx.objectStore('customers').delete(id)
    })
    if (changes.references_included) {
      await writeBatches(staleKeys(snapshotKeys.categories, changes.categories ?? []), ['categories'], (tx, id) => {
        tx.objectStore('categories').delete(id)
      })
      await writeBatches(staleKeys(snapshotKeys.brands, changes.brands ?? []), ['brands'], (tx, id) => {
        tx.objectStore('brands').delete(id)
      })
    }
  }

  await writeBatches(changes.sales ?? [], ['sales'], (tx, sale) => {
    const salesStore = tx.objectStore('sales')
    const req = salesStore.index('by_server_id').getAll(sale.id)
    req.onsuccess = () => {
      const existing = (req.result as LocalSaleRecord[] | undefined)
        ?.find((record) => record.scope_key === scopeKey)
      salesStore.put({
        ...existing,
        ...sale,
        local_id: existing?.local_id ?? `server:${scopeKey}:${sale.id}`,
        scope_key: scopeKey,
        server_id: sale.id,
        sync_status: existing?.sync_status === 'synced' ? 'synced' : 'remote',
        sync_error: null,
        synced_at: existing?.synced_at ?? new Date().toISOString(),
      })
    }
  })

  const now = Date.now()
  await transact(['meta', 'sync_log'], (tx) => {
    tx.objectStore('meta').put({ key: 'products_cached_at', value: now })
    tx.objectStore('meta').put({ key: 'cache_scope', value: scopeKey })
    tx.objectStore('meta').put({
      key: syncMetaKey(scopeKey),
      value: {
        cursor: changes.cursor,
        reset_generation: Number(changes.reset_generation ?? previousSyncState.reset_generation),
        last_success_at: now,
        last_attempt_at: now,
        last_error: null,
        last_reference_sync_at: changes.references_included
          ? now
          : previousSyncState.last_reference_sync_at,
        snapshot_in_progress: false,
      } satisfies LocalSyncState,
    })
    tx.objectStore('sync_log').add({
      created_at: new Date().toISOString(),
      level: 'success',
      message: [
        'products=', changes.products?.length ?? 0,
        '; customers=', changes.customers?.length ?? 0,
        '; sales=', changes.sales?.length ?? 0,
      ].join(''),
    })
  })

  window.dispatchEvent(new CustomEvent('forsage:offline-stock-updated'))
}

export async function commitLocalSale(
  pendingSale: PendingSale,
  receipt: Omit<LocalSaleRecord, 'local_id' | 'server_id' | 'sync_status' | 'sync_error' | 'synced_at'>,
  scopeKey: string,
): Promise<void> {
  assertBrowserQueueUsable('commitLocalSale')
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pending_sales', 'sales', 'products', 'meta'], 'readwrite')
    tx.objectStore('pending_sales').add({ ...pendingSale, scope_key: scopeKey })
    tx.objectStore('sales').put({
      ...receipt,
      local_id: pendingSale.offline_id,
      scope_key: scopeKey,
      server_id: null,
      sync_status: 'pending',
      sync_error: null,
      synced_at: null,
    } satisfies LocalSaleRecord)

    const productsStore = tx.objectStore('products')
    for (const item of pendingSale.items) {
      const req = productsStore.get(item.product_id)
      req.onsuccess = () => {
        const product = req.result
        if (!product || product.is_service) return
        productsStore.put({
          ...product,
          qty_on_hand: Math.max(0, Number(product.qty_on_hand ?? 0) - item.qty),
          qty_available: Math.max(0, Number(product.qty_available ?? product.qty_on_hand ?? 0) - item.qty),
        })
      }
    }

    tx.objectStore('meta').put({ key: 'cache_scope', value: scopeKey })
    tx.oncomplete = () => {
      window.dispatchEvent(new CustomEvent('forsage:offline-stock-updated'))
      resolve()
    }
    tx.onerror = () => reject(tx.error)
  })
}

export async function completePendingSaleSync(
  offlineId: string,
  serverSale: any,
  scopeKey: string,
): Promise<void> {
  assertBrowserQueueUsable('completePendingSaleSync')
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pending_sales', 'sales'], 'readwrite')
    const pendingStore = tx.objectStore('pending_sales')
    const pendingReq = pendingStore.get(offlineId)
    pendingReq.onsuccess = () => {
      if (pendingReq.result?.scope_key === scopeKey) pendingStore.delete(offlineId)
    }
    const salesStore = tx.objectStore('sales')
    const req = salesStore.get(offlineId)
    req.onsuccess = () => {
      const local = req.result
      if (!local || local.scope_key !== scopeKey) return
      salesStore.put({
        ...local,
        ...serverSale,
        local_id: offlineId,
        server_id: serverSale.id,
        sync_status: 'synced',
        sync_error: null,
        synced_at: new Date().toISOString(),
      })
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getLocalSales(limit = 100, scopeKey: string): Promise<LocalSaleRecord[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sales', 'readonly')
    const req = tx.objectStore('sales').index('by_scope').getAll(scopeKey)
    req.onsuccess = () => resolve((req.result ?? [])
      .sort((a: LocalSaleRecord, b: LocalSaleRecord) =>
        new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime())
      .slice(0, limit))
    req.onerror = () => reject(req.error)
  })
}

export async function getLocalSale(id: string, scopeKey: string): Promise<LocalSaleRecord | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sales', 'readonly')
    const store = tx.objectStore('sales')
    const localRequest = store.get(id)
    localRequest.onsuccess = () => {
      if (localRequest.result?.scope_key === scopeKey) {
        resolve(localRequest.result)
        return
      }
      const serverRequest = store.index('by_server_id').getAll(id)
      serverRequest.onsuccess = () => resolve(
        (serverRequest.result as LocalSaleRecord[] | undefined)
          ?.find((record) => record.scope_key === scopeKey) ?? null,
      )
      serverRequest.onerror = () => reject(serverRequest.error)
    }
    localRequest.onerror = () => reject(localRequest.error)
  })
}

export async function enqueueSale(sale: PendingSale): Promise<void> {
  assertBrowserQueueUsable('enqueueSale')
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('pending_sales', 'readwrite')
    tx.objectStore('pending_sales').add(sale)
    tx.oncomplete = () => resolve()
    tx.onerror    = () => reject(tx.error)
  })
}

export async function getPendingSales(scopeKey: string): Promise<PendingSale[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('pending_sales', 'readonly')
    const req = tx.objectStore('pending_sales').index('by_scope').getAll(scopeKey)
    req.onsuccess = () => resolve(
      (req.result ?? []).sort((a: PendingSale, b: PendingSale) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      )
    )
    req.onerror   = () => reject(req.error)
  })
}

export async function markPendingSaleFailed(
  offlineId: string,
  error: string,
  scopeKey: string,
): Promise<void> {
  assertBrowserQueueUsable('markPendingSaleFailed')
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pending_sales', 'sales'], 'readwrite')
    const store = tx.objectStore('pending_sales')
    const req = store.get(offlineId)
    req.onsuccess = () => {
      if (!req.result || req.result.scope_key !== scopeKey) return
      store.put({
        ...req.result,
        sync_status: 'failed',
        sync_attempts: (req.result.sync_attempts ?? 0) + 1,
        last_error: error.slice(0, 500),
      })
    }
    const saleReq = tx.objectStore('sales').get(offlineId)
    saleReq.onsuccess = () => {
      if (!saleReq.result || saleReq.result.scope_key !== scopeKey) return
      tx.objectStore('sales').put({
        ...saleReq.result,
        sync_status: 'failed',
        sync_error: error.slice(0, 500),
      })
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function removePendingSale(offlineId: string, scopeKey: string): Promise<void> {
  assertBrowserQueueUsable('removePendingSale')
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending_sales', 'readwrite')
    const store = tx.objectStore('pending_sales')
    const request = store.get(offlineId)
    request.onsuccess = () => {
      if (request.result?.scope_key === scopeKey) store.delete(offlineId)
    }
    tx.oncomplete = () => resolve()
    tx.onerror    = () => reject(tx.error)
  })
}

export async function countPendingSales(scopeKey: string): Promise<number> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('pending_sales', 'readonly')
    const req = tx.objectStore('pending_sales').index('by_scope').count(scopeKey)
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}



