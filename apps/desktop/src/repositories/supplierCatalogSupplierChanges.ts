import type { LocalDatabase } from '../db/localDatabase'
import type { SupplierCatalogWriteGuard } from './supplierCatalogWriteSafety'

type Change = { from: string | null; to: string | null; at: string }
export const catalogMergeError = () => new Error('Прайси або історія постачальника неузгоджені. Злиття зупинено; товари, оплати й залишки не змінено.')
const keyFor = (tenant: string, id: string) => 'catalog-supplier-changes:' + tenant + ':' + id

export function readCatalogSupplierChanges(db: LocalDatabase, tenant: string, id: string): Change[] {
  const row = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(keyFor(tenant,id)) as any
  if (!row) return []
  let parsed: any
  try { parsed = JSON.parse(row.value_json) } catch { throw catalogMergeError() }
  if (!Array.isArray(parsed) || parsed.some(c => !c || Object.keys(c).sort().join(',') !== 'at,from,to'
    || !(c.from === null || typeof c.from === 'string') || !(c.to === null || typeof c.to === 'string')
    || c.from === c.to || typeof c.at !== 'string' || !Number.isFinite(Date.parse(c.at)))) throw catalogMergeError()
  return parsed
}

/** Durable evidence of an explicit edit; old outbox requests remain immutable. */
export function recordCatalogSupplierChange(db: LocalDatabase, guard: SupplierCatalogWriteGuard,
  tenant: string, id: string, from: string | null, to: string | null, at: string): void {
  if (from === to) return
  const changes = readCatalogSupplierChanges(db,tenant,id)
  changes.push({from,to,at})
  const key = keyFor(tenant,id), value_json = JSON.stringify(changes)
  guard.written(db.prepare('INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at')
    .run(key,value_json,at))
  guard.expectMeta({key,value_json,updated_at:at})
}
