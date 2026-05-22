interface CacheEntry<V> {
  value: V
  expiresAt: number
}

export class SimpleCache<K, V> {
  private store = new Map<K, CacheEntry<V>>()
  private ttlMs: number

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: K, value: V): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs })
  }

  delete(key: K): void {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }

  // Видаляємо всі записи де ключ відповідає предикату
  invalidateWhere(predicate: (key: K) => boolean): void {
    for (const key of this.store.keys()) {
      if (predicate(key)) this.store.delete(key)
    }
  }
}
