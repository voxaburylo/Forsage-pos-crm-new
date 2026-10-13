import { createHash } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID } from '../db/localTypes'
import { hashSecret } from '../security/secretHash'
import { LanUnavailableError } from './orderQueue'
import { privateHubAddress } from './discovery'

const BINDING = 'lan-client-identity:v1'
const ROLES = new Set(['owner', 'admin', 'manager'])
const BUSINESS_TABLES = [
  'products', 'customers', 'suppliers', 'sales', 'shifts', 'customer_orders',
  'supply_invoices', 'inventory_movements', 'warehouse_movements', 'inventory_sessions',
  'stock_reserves', 'supplier_payments', 'cash_operations', 'bonus_transactions',
  'customer_returns', 'writeoffs', 'internal_consumptions', 'salary_payments', 'sync_outbox',
] as const

export interface LanLoginProfile {
  id: string; tenant_id: string; role: string; full_name: string; phone: string; is_active: boolean
}

function hasRows(db: LocalDatabase, table: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
}
function hasBusinessData(db: LocalDatabase): boolean {
  return BUSINESS_TABLES.some(table => hasRows(db, table))
}
function phoneKey(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return digits.startsWith('0') ? `38${digits}` : digits.startsWith('80') ? `3${digits}` : digits
}
function keyFingerprint(key: string): string {
  if (key.length < 16 || key.length > 256) throw new Error('Некоректний код підключення')
  return createHash('sha256').update(key).digest('hex')
}

/** Public bootstrap never reads/discloses shop identities and never adopts a working shop DB. */
export function canPairEmptyClient(db: LocalDatabase, mode: string, hasPending: boolean): boolean {
  return mode === 'standalone' && !hasPending && !hasBusinessData(db) && !hasRows(db, 'staff_users')
    && !db.prepare('SELECT 1 FROM app_meta WHERE key=?').get(BINDING)
}

export function hasLanIdentity(db: LocalDatabase): boolean {
  return Boolean(db.prepare('SELECT 1 FROM app_meta WHERE key=?').get(BINDING))
}

/** A missing/damaged LAN config must never turn a cached manager into an independent shop. */
export function assertLanIdentityConnection(db: LocalDatabase, config: { mode: string; accessKey: string; hubAddress?: string; secureTransport?: 1 }): void {
  const stored = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(BINDING) as { value_json: string } | undefined
  if (!stored) return
  try {
    const binding = JSON.parse(stored.value_json) as { fingerprint?: unknown; tenant?: unknown }
    if (config.mode === 'client' && config.secureTransport === 1 && binding.tenant === DEFAULT_TENANT_ID
      && binding.fingerprint === keyFingerprint(config.accessKey) && privateHubAddress(config.hubAddress)) return
  } catch { /* Malformed configuration is not permission to create a second stock database. */ }
  throw new Error('Підключення ПК менеджера пошкоджено. Дані збережено; незалежну касу не відкрито.')
}

/** Only main calls this after encrypted, hub-verified password authentication. No stock or outbox writes. */
export function cacheLanIdentity(db: LocalDatabase, profile: LanLoginProfile, phone: string, password: string, accessKey: string): void {
  if (!profile || typeof profile.id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(profile.id)
    || profile.tenant_id !== DEFAULT_TENANT_ID || !ROLES.has(profile.role) || profile.is_active !== true
    || typeof profile.full_name !== 'string' || !profile.full_name.trim() || profile.full_name.length > 200
    || typeof profile.phone !== 'string' || !/^380\d{9}$/.test(phoneKey(phone))
    || phoneKey(profile.phone) !== phoneKey(phone) || typeof password !== 'string' || !password || password.length > 1024) {
    throw new Error('Головний ПК не підтвердив обліковий запис працівника')
  }
  const binding = keyFingerprint(accessKey)
  db.transaction(() => {
    if (hasBusinessData(db)) throw new Error('На цьому ПК є дані окремого магазину. Підключення не змінено.')
    const stored = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(BINDING) as {value_json:string} | undefined
    const previous = stored ? JSON.parse(stored.value_json) as {fingerprint?: string; tenant?: string} : null
    if (previous && (previous.fingerprint !== binding || previous.tenant !== profile.tenant_id)) {
      throw new Error('Збережений профіль належить іншому підключенню. Дані не перезаписано.')
    }
    const existing = db.prepare('SELECT id,tenant_id,is_active FROM staff_users').all() as {id:string;tenant_id:string;is_active:number}[]
    // Never convert a previously independent operator database into a manager cache.
    if (!previous && existing.length) throw new Error('Перший вхід потребує чистого профілю ПК менеджера')
    if (existing.some(row => row.tenant_id !== profile.tenant_id)) throw new Error('Профіль іншого магазину не змінено')
    if (existing.some(row => row.is_active === 1 && row.id !== profile.id)) {
      const queues = db.prepare("SELECT value_json FROM app_meta WHERE key LIKE 'lan-order-workspace:v1:%'").all() as { value_json: string }[]
      const pending = queues.some(row => {
        const state = JSON.parse(row.value_json) as { drafts?: { jobs?: unknown[] }[] }
        if (!Array.isArray(state.drafts) || state.drafts.some(draft => !Array.isArray(draft.jobs))) {
          throw new Error('Локальна черга замовлень пошкоджена. Зміна працівника не виконана.')
        }
        return state.drafts.some(draft => draft.jobs!.length > 0)
      })
      if (pending) throw new Error('Спочатку передайте або перевірте замовлення попереднього працівника. Його профіль і правки збережено.')
    }
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO staff_users(id,tenant_id,full_name,role,phone,is_active,password_hash,created_at,updated_at)
      VALUES(?,?,?,?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET full_name=excluded.full_name,
      role=excluded.role,phone=excluded.phone,is_active=1,password_hash=excluded.password_hash,
      updated_at=excluded.updated_at,deleted_at=NULL,dirty_at=NULL`).run(
      profile.id, profile.tenant_id, profile.full_name.trim(), profile.role, `+${phoneKey(phone)}`, hashSecret(password), now, now)
    // Only the account most recently confirmed by the hub may enter this paired workstation offline.
    db.prepare('UPDATE staff_users SET is_active=0 WHERE id<>?').run(profile.id)
    db.prepare(`INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .run(BINDING, JSON.stringify({fingerprint:binding,tenant:profile.tenant_id}), now)
  })
}

export async function loginLanClient<T>(input: {
  remote: () => Promise<LanLoginProfile>; cache: (profile: LanLoginProfile) => void; local: () => T
}): Promise<T> {
  try { input.cache(await input.remote()) }
  catch (error) {
    // Invalid password, disabled account, wrong code, protocol or malformed reply NEVER fall back.
    if (!(error instanceof LanUnavailableError)) throw error
  }
  return input.local()
}
