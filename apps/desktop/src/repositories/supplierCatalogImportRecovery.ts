import type { LocalDatabase } from '../db/localDatabase'
import { idempotentMutation } from './idempotentMutation'
import { SupplierCatalogWriteGuard, catalogWriteConflict } from './supplierCatalogWriteSafety'

export type CatalogImportResult = { success: true; importId: string }
type Receipt = { fingerprint: string; result: CatalogImportResult } | { cancelled: true }
const damaged = () => new Error('Пошкоджено підтвердження імпорту прайсу. Повторний запис заблоковано; потрібна перевірка.')
function scopeFor(tenant: string, user: unknown, operation: unknown): string {
  const valid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value)
  if (!valid(operation) || !valid(user) || !valid(tenant)) throw new Error('Некоректний ідентифікатор спроби імпорту або працівника. Прайс не змінено.')
  return 'supplier-import:' + tenant + ':' + user
}
function readReceipt(db: LocalDatabase, key: string): Receipt | undefined {
  const row = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(key) as { value_json: string } | undefined
  if (!row) return undefined
  let saved: any
  try { saved = JSON.parse(row.value_json) } catch { throw damaged() }
  if (saved?.cancelled === true && Object.keys(saved).length === 1) return saved
  if (saved && Object.keys(saved).length === 2 && /^[a-f0-9]{64}$/.test(saved.fingerprint)
    && saved.result?.success === true && Object.keys(saved.result).length === 2
    && typeof saved.result.importId === 'string' && /^[a-f0-9-]{36}$/i.test(saved.result.importId)) return saved
  throw damaged()
}

/** Same transaction owns business rows and the durable acknowledgement. */
export function runCatalogImport(db: LocalDatabase, tenant: string, user: unknown, operation: unknown,
  payload: unknown, work: (capture: (guard: SupplierCatalogWriteGuard) => void) => CatalogImportResult): CatalogImportResult {
  const scope = scopeFor(tenant, user, operation), key = 'mutation:' + scope + ':' + operation
  return db.transaction(() => {
    readReceipt(db, key) // Never treat malformed/corrupted evidence as a new request.
    let guard: SupplierCatalogWriteGuard | undefined
    return idempotentMutation(db, scope, operation as string, payload,
      () => work(value => { guard = value }),
      () => {
        if (!guard) throw catalogWriteConflict()
        return () => guard!.verifyAfterReceipt()
      })
  })
}

/** A negative answer is a durable fence, not a racy absence check. */
export function resolveCatalogImport(db: LocalDatabase, tenant: string, user: string, operation: string):
  { status: 'committed'; result: CatalogImportResult } | { status: 'not_committed' } {
  const scope = scopeFor(tenant, user, operation), key = 'mutation:' + scope + ':' + operation
  return db.transaction(() => {
    const receipt = readReceipt(db, key)
    if (receipt) return 'cancelled' in receipt ? { status: 'not_committed' } : { status: 'committed', result: receipt.result }
    const guard = new SupplierCatalogWriteGuard(db)
    const value = JSON.stringify({ cancelled: true }), at = new Date().toISOString()
    guard.written(db.prepare('INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?)').run(key, value, at))
    guard.verify()
    const stored = db.prepare('SELECT value_json,updated_at FROM app_meta WHERE key=?').get(key) as { value_json: string; updated_at: string } | undefined
    if (stored?.value_json !== value || stored.updated_at !== at) throw catalogWriteConflict()
    return { status: 'not_committed' }
  })
}
