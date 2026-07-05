/**
 * IndexedDB обгортка для офлайн-режиму POS
 *
 * Stores:
 *   products      — кеш каталогу товарів (оновлюється кожні 30 хв)
 *   categories    — кеш категорій для пошуку
 *   pending_sales — черга продажів, зроблених без інтернету
 *   meta          — час кешування та остання відкрита зміна
 */

const DB_NAME    = 'forsage_offline'
const DB_VERSION = 4

export async function ensurePersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  if (await navigator.storage.persisted()) return true
  return navigator.storage.persist()
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result

      if (!db.objectStoreNames.contains('products')) {
        const store = db.createObjectStore('products', { keyPath: 'id' })
        store.createIndex('by_sku',  'sku',     { unique: false })
        store.createIndex('by_name', 'name',    { unique: false })
        store.createIndex('by_barcode', 'barcode', { unique: false })
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

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' })
      }
    }

    req.onsuccess  = () => resolve(req.result)
    req.onerror    = () => reject(req.error)
  })
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
    const tx = db.transaction('pending_sales', 'readwrite')
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
