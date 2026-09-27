/** Small LRU for disposable read results, never for pending edits or payments. */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, V>()
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Cache capacity must be a positive integer')
  }
  get size() { return this.entries.size }
  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined
    const value = this.entries.get(key)!
    this.entries.delete(key); this.entries.set(key, value)
    return value
  }
  set(key: K, value: V): void {
    this.entries.delete(key); this.entries.set(key, value)
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!)
  }
  clear(): void { this.entries.clear() }
}
