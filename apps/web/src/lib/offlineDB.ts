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
 */

const DB_NAME    = 'forsage_offline'
const DB_VERSION = 6
let dbPromise: Promise<IDBDatabase> | null = null

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
      } else {
        const store = req.transaction!.objectStore('products')
        if (!store.indexNames.contains('by_sku')) store.createIndex('by_sku', 'sku', { unique: false })
        if (!store.indexNames.contains('by_name')) store.createIndex('by_name', 'name', { unique: false })
        if (!store.indexNames.contains('by_barcode')) store.createIndex('by_barcode', 'barcode', { unique: false })
      }

      if (!db.objectStoreNames.contains('pending_sales')) {
        const store = db.createObjectStore('pending_sales', { keyPath: 'offline_id' })
        store.createIndex('by_created', 'created_at', { unique: false })
        store.createIndex('by_status', 'sync_status', { unique: false })
      } else {
        const store = req.transaction!.objectStore('pending_sales')
        if (!store.indexNames.contains('by_status')) {
          store.createIndex('by_status', 'sync_status', { unique: false })
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
    tx.oncomplete = () => resolve()
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
      const q = query.toLocaleLowerCase('uk-UA').trim()
      const normalized = q.replace(/[\s\-./_]/g, '')
      const results = (req.result as any[])
        .filter((p) => {
          if (p.is_active === false || (categoryName && p.category?.name !== categoryName)) return false
          const name = String(p.name ?? '').toLocaleLowerCase('uk-UA')
          const sku = String(p.sku ?? '').toLocaleLowerCase('uk-UA')
          const normalizedSku = sku.replace(/[\s\-./_]/g, '')
          const barcodes = [
            p.barcode,
            ...(Array.isArray(p.additional_barcodes) ? p.additional_barcodes : []),
          ].filter(Boolean).map(String)
          return name.includes(q) || sku.includes(q) || normalizedSku.includes(normalized) || barcodes.includes(query)
        })
        .sort((a, b) => {
          const exactA = String(a.barcode ?? '') === query || String(a.sku ?? '').replace(/[\s\-./_]/g, '').toLowerCase() === normalized
          const exactB = String(b.barcode ?? '') === query || String(b.sku ?? '').replace(/[\s\-./_]/g, '').toLowerCase() === normalized
          return Number(exactB) - Number(exactA)
        })
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

  // Додаткові штрихкоди зберігаються масивом і не мають окремого індексу.
  // Повний пошук потрібен лише як рідкісний fallback.
  const candidates = await searchProductsOffline(code, 20, scopeKey)
  return candidates.find((product) => {
    const barcodes = [
      product.barcode,
      ...(Array.isArray(product.additional_barcodes) ? product.additional_barcodes : []),
    ].filter(Boolean).map(String)
    const sku = String(product.sku ?? '').replace(/[\s\-./_]/g, '').toUpperCase()
    return barcodes.includes(code) || sku === normalizedSku
  }) ?? null
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
  product_aliases?: any[]
  product_cross_numbers?: any[]
  customer_vehicles?: any[]
  references_included: boolean
}

export interface LocalSyncState {
  cursor: string | null
  last_success_at: number | null
  last_attempt_at: number | null
  last_error: string | null
  last_reference_sync_at: number | null
}

function syncMetaKey(scopeKey: string): string {
  return `sync_state:${scopeKey}`
}

export async function getLocalSyncState(scopeKey: string): Promise<LocalSyncState> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly')
    const req = tx.objectStore('meta').get(syncMetaKey(scopeKey))
    req.onsuccess = () => resolve(req.result?.value ?? {
      cursor: null,
      last_success_at: null,
      last_attempt_at: null,
      last_error: null,
      last_reference_sync_at: null,
    })
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

  const search = String(options.search ?? '').toLocaleLowerCase('uk-UA').trim()
  const normalized = search.replace(/[\s\-./_]/g, '')
  const filtered = all.filter((product) => {
    if (product.is_active === false) return false
    if (options.categoryId && product.category_id !== options.categoryId) return false
    if (options.brandId && product.brand_id !== options.brandId) return false
    if (options.lowStock && Number(product.qty_on_hand ?? 0) > Number(product.reorder_point ?? 0)) return false
    if (options.stockFilter === 'negative' && Number(product.qty_on_hand ?? 0) >= 0) return false
    if (options.stockFilter === 'no_price' && Number(product.retail_price ?? 0) !== 0) return false
    if (!search) return true
    const name = String(product.name ?? '').toLocaleLowerCase('uk-UA')
    const sku = String(product.sku ?? '').toLocaleLowerCase('uk-UA')
    const skuNormalized = sku.replace(/[\s\-./_]/g, '')
    const barcodes = [product.barcode, ...(product.additional_barcodes ?? [])]
      .filter(Boolean).map((value) => String(value).toLocaleLowerCase('uk-UA'))
    return name.includes(search)
      || sku.includes(search)
      || skuNormalized.includes(normalized)
      || barcodes.some((barcode) => barcode.includes(search))
  })

  const field = options.sortField ?? 'name'
  const direction = options.sortDir === 'desc' ? -1 : 1
  filtered.sort((a, b) => {
    const left = field === 'brand' ? a.brand?.name : a[field]
    const right = field === 'brand' ? b.brand?.name : b[field]
    if (typeof left === 'number' || typeof right === 'number') {
      return (Number(left ?? 0) - Number(right ?? 0)) * direction
    }
    return String(left ?? '').localeCompare(String(right ?? ''), 'uk') * direction
  })

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

export async function applySyncChanges(
  changes: SyncChanges,
  scopeKey: string,
  replaceSnapshot: boolean,
): Promise<void> {
  const pending = await getPendingSales()
  const previousSyncState = await getLocalSyncState(scopeKey)
  const pendingQty = new Map<string, number>()
  for (const sale of pending) {
    for (const item of sale.items) {
      pendingQty.set(item.product_id, (pendingQty.get(item.product_id) ?? 0) + Number(item.qty))
    }
  }

  const db = await openDB()
  return new Promise((resolve, reject) => {
    const stores = ['products', 'customers', 'sales', 'categories', 'brands', 'meta', 'sync_log']
    const tx = db.transaction(stores, 'readwrite')
    const productsStore = tx.objectStore('products')
    const customersStore = tx.objectStore('customers')
    const salesStore = tx.objectStore('sales')
    const categoriesStore = tx.objectStore('categories')
    const brandsStore = tx.objectStore('brands')

    if (replaceSnapshot) {
      productsStore.clear()
      customersStore.clear()
    }
    if (replaceSnapshot || changes.references_included) {
      categoriesStore.clear()
      brandsStore.clear()
    }

    for (const product of changes.products ?? []) {
      const queuedQty = pendingQty.get(product.id) ?? 0
      productsStore.put({
        ...product,
        qty_on_hand: product.is_service
          ? product.qty_on_hand
          : Math.max(0, Number(product.qty_on_hand ?? 0) - queuedQty),
        qty_available: product.is_service
          ? product.qty_available
          : Math.max(0, Number(product.qty_available ?? product.qty_on_hand ?? 0) - queuedQty),
      })
    }
    for (const id of changes.deleted_product_ids ?? []) productsStore.delete(id)

    for (const customer of changes.customers ?? []) customersStore.put(customer)
    for (const id of changes.deleted_customer_ids ?? []) customersStore.delete(id)
    for (const category of changes.categories ?? []) categoriesStore.put(category)
    for (const brand of changes.brands ?? []) brandsStore.put(brand)

    const serverIndex = salesStore.index('by_server_id')
    for (const sale of changes.sales ?? []) {
      const req = serverIndex.get(sale.id)
      req.onsuccess = () => {
        const existing = req.result as LocalSaleRecord | undefined
        salesStore.put({
          ...existing,
          ...sale,
          local_id: existing?.local_id ?? `server:${sale.id}`,
          server_id: sale.id,
          sync_status: existing?.sync_status === 'synced' ? 'synced' : 'remote',
          sync_error: null,
          synced_at: existing?.synced_at ?? new Date().toISOString(),
        })
      }
    }

    const now = Date.now()
    tx.objectStore('meta').put({ key: 'products_cached_at', value: now })
    tx.objectStore('meta').put({ key: 'cache_scope', value: scopeKey })
    tx.objectStore('meta').put({
      key: syncMetaKey(scopeKey),
      value: {
        cursor: changes.cursor,
        last_success_at: now,
        last_attempt_at: now,
        last_error: null,
        last_reference_sync_at: changes.references_included
          ? now
          : previousSyncState.last_reference_sync_at,
      } satisfies LocalSyncState,
    })
    tx.objectStore('sync_log').add({
      created_at: new Date().toISOString(),
      level: 'success',
      message: `products=${changes.products?.length ?? 0}; customers=${changes.customers?.length ?? 0}; sales=${changes.sales?.length ?? 0}`,
    })

    tx.oncomplete = () => {
      window.dispatchEvent(new CustomEvent('forsage:offline-stock-updated'))
      resolve()
    }
    tx.onerror = () => reject(tx.error)
  })
}

export async function commitLocalSale(
  pendingSale: PendingSale,
  receipt: Omit<LocalSaleRecord, 'local_id' | 'server_id' | 'sync_status' | 'sync_error' | 'synced_at'>,
  scopeKey: string,
): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pending_sales', 'sales', 'products', 'meta'], 'readwrite')
    tx.objectStore('pending_sales').add(pendingSale)
    tx.objectStore('sales').put({
      ...receipt,
      local_id: pendingSale.offline_id,
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

export async function completePendingSaleSync(offlineId: string, serverSale: any): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pending_sales', 'sales'], 'readwrite')
    tx.objectStore('pending_sales').delete(offlineId)
    const salesStore = tx.objectStore('sales')
    const req = salesStore.get(offlineId)
    req.onsuccess = () => {
      const local = req.result
      if (!local) return
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

export async function getLocalSales(limit = 100): Promise<LocalSaleRecord[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sales', 'readonly')
    const req = tx.objectStore('sales').getAll()
    req.onsuccess = () => resolve((req.result ?? [])
      .sort((a: LocalSaleRecord, b: LocalSaleRecord) =>
        new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime())
      .slice(0, limit))
    req.onerror = () => reject(req.error)
  })
}

export async function getLocalSale(id: string): Promise<LocalSaleRecord | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sales', 'readonly')
    const store = tx.objectStore('sales')
    const localRequest = store.get(id)
    localRequest.onsuccess = () => {
      if (localRequest.result) {
        resolve(localRequest.result)
        return
      }
      const serverRequest = store.index('by_server_id').get(id)
      serverRequest.onsuccess = () => resolve(serverRequest.result ?? null)
      serverRequest.onerror = () => reject(serverRequest.error)
    }
    localRequest.onerror = () => reject(localRequest.error)
  })
}

export async function enqueueSale(sale: PendingSale): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('pending_sales', 'readwrite')
    tx.objectStore('pending_sales').add(sale)
    tx.oncomplete = () => resolve()
    tx.onerror    = () => reject(tx.error)
  })
}

export async function getPendingSales(): Promise<PendingSale[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('pending_sales', 'readonly')
    const req = tx.objectStore('pending_sales').getAll()
    req.onsuccess = () => resolve(
      (req.result ?? []).sort((a: PendingSale, b: PendingSale) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      )
    )
    req.onerror   = () => reject(req.error)
  })
}

export async function markPendingSaleFailed(offlineId: string, error: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pending_sales', 'sales'], 'readwrite')
    const store = tx.objectStore('pending_sales')
    const req = store.get(offlineId)
    req.onsuccess = () => {
      if (!req.result) return
      store.put({
        ...req.result,
        sync_status: 'failed',
        sync_attempts: (req.result.sync_attempts ?? 0) + 1,
        last_error: error.slice(0, 500),
      })
    }
    const saleReq = tx.objectStore('sales').get(offlineId)
    saleReq.onsuccess = () => {
      if (!saleReq.result) return
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

export async function removePendingSale(offlineId: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending_sales', 'readwrite')
    tx.objectStore('pending_sales').delete(offlineId)
    tx.oncomplete = () => resolve()
    tx.onerror    = () => reject(tx.error)
  })
}

export async function countPendingSales(): Promise<number> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('pending_sales', 'readonly')
    const req = tx.objectStore('pending_sales').count()
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}
