export function readOrderFormDraft<T>(key: string, storage?: Pick<Storage, 'getItem'>): T | null {
  try {
    const raw = storage ? storage.getItem(key) : localStorage.getItem(key) ?? sessionStorage.getItem(key)
    if (raw === null) return null
    const entry = JSON.parse(raw)
    if (entry?.version !== 1 || !entry.data || !Array.isArray(entry.data.items)) throw Error()
    if (!entry.data.items.every((row: unknown) => !!row && typeof row === 'object'
      && ['name', 'sku', 'qty', 'sell_price', 'supplier_id'].every((field) => typeof (row as Record<string, unknown>)[field] === 'string'))) throw Error()
    for (const field of ['customerId','comment','newCustName','newCustPhone','newVehBrand','newVehModel','newVehYear','newVehVin','loadedOrderVersion']) {
      if (entry.data[field] !== undefined && typeof entry.data[field] !== 'string') throw Error()
    }
    for (const field of ['isUrgent','showAddCustomer','showAddVehicle']) {
      if (entry.data[field] !== undefined && typeof entry.data[field] !== 'boolean') throw Error()
    }
    if (entry.data.step !== undefined && ![1,2,3,4].includes(entry.data.step)) throw Error()
    if (entry.data.totalPaid !== undefined && (!Number.isFinite(entry.data.totalPaid) || entry.data.totalPaid < 0)) throw Error()
    const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
    if (entry.data.vehicles !== undefined && (!Array.isArray(entry.data.vehicles) || !entry.data.vehicles.every((vehicle: unknown) => record(vehicle) && typeof vehicle.id === 'string'))) throw Error()
    for (const field of ['selectedCustomer','selectedVehicle','loadedVehicleInfo','draftHint']) {
      if (entry.data[field] != null && !record(entry.data[field])) throw Error()
    }
    if (entry.data.draftHint && !Array.isArray(entry.data.draftHint.items)) throw Error()
    if (!storage && localStorage.getItem(key) === null) localStorage.setItem(key, raw)
    return entry.data as T
  } catch { throw new Error('Не вдалося прочитати збережену форму замовлення. Дані не видалено й не перезаписано; потрібна перевірка локального сховища.') }
}

export function writeOrderFormDraft<T>(key: string, data: T, storage?: Pick<Storage, 'setItem'>): boolean {
  try { (storage ?? localStorage).setItem(key, JSON.stringify({ version: 1, data })); return true }
  catch { return false }
}

export function removeOrderFormDraft(key: string): void {
  // Remove the legacy copy first; if removal fails, retain the durable copy and pending marker.
  sessionStorage.removeItem(key)
  localStorage.removeItem(key)
}
