/**
 * IndexedDB обгортка для офлайн-режиму POS
 *
 * Stores:
 *   products      — кеш каталогу товарів (оновлюється кожні 30 хв)
 *   pending_sales — черга продажів які зроблені без інтернету
 */

const DB_NAME    = 'forsage_offline'
const DB_VERSION = 1

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

export async function cacheProducts(products: any[]): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(['products', 'meta'], 'readwrite')
    const store = tx.objectStore('products')

    // Очищаємо і перезаписуємо
    store.clear()
    for (const p of products) store.put(p)

    tx.objectStore('meta').put({ key: 'products_cached_at', value: Date.now() })
    tx.oncomplete = () => resolve()
    tx.onerror    = () => reject(tx.error)
  })
}

export async function searchProductsOffline(query: string, limit = 20): Promise<any[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('products', 'readonly')
    const store = tx.objectStore('products')
    const req   = store.getAll()

    req.onsuccess = () => {
      const q = query.toLowerCase().trim()
      const results = (req.result as any[])
        .filter((p) =>
          p.is_active !== false &&
          (
            p.name?.toLowerCase().includes(q) ||
            p.sku?.toLowerCase().includes(q)  ||
            p.barcode === query
          )
        )
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

// ─── Pending sales queue ──────────────────────────────────────────────────────

export interface PendingSale {
  offline_id:     string   // crypto.randomUUID()
  created_at:     string   // ISO
  shift_id:       string
  customer_id:    string | null
  manager_id:     string | null
  items:          Array<{ product_id: string; qty: number; unit_price: number; discount: number }>
  payment_method: string
  total:          number
  notes:          string | null
  idempotency_key: string
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
    req.onsuccess = () => resolve(req.result ?? [])
    req.onerror   = () => reject(req.error)
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
