export function readOrderFormDraft<T>(key: string, storage?: Pick<Storage, 'getItem'>): T | null {
  try {
    const entry = JSON.parse((storage ?? sessionStorage).getItem(key) ?? 'null')
    if (entry?.version !== 1 || !entry.data || !Array.isArray(entry.data.items)) return null
    if (!entry.data.items.every((row: unknown) => !!row && typeof row === 'object'
      && ['name', 'sku', 'qty', 'sell_price', 'supplier_id'].every((field) => typeof (row as Record<string, unknown>)[field] === 'string'))) return null
    return entry.data as T
  } catch { return null }
}

export function writeOrderFormDraft<T>(key: string, data: T, storage?: Pick<Storage, 'setItem'>): boolean {
  try { (storage ?? sessionStorage).setItem(key, JSON.stringify({ version: 1, data })); return true }
  catch { return false }
}
