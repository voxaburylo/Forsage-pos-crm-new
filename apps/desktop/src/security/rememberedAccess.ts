import { createHash } from 'node:crypto'
import { verifySecret } from './secretHash'

export interface RememberedUser {
  id: string; tenant_id: string; role: string; phone: string; full_name: string
  password_hash: string; pin_hash: string; is_active: number; deleted_at: string | null
}
interface Lease { id: string; tenant: string; fingerprint: string; expires: number; issued: number; attempts: number }
interface Dependencies {
  read: () => string | null; write: (value: string | null) => void
  encrypt: (text: string) => string; decrypt: (text: string) => string
  user: (id: string, tenant: string) => RememberedUser | null
  now?: () => number
  pinRequired?: () => boolean
}
const DAY = 24 * 60 * 60 * 1000
export class RememberedAccess {
  private locked = true
  constructor(private readonly deps: Dependencies) {}
  private now() { return (this.deps.now ?? Date.now)() }
  private needsPin() { return this.deps.pinRequired?.() !== false }
  private fingerprint(u: RememberedUser) {
    return createHash('sha256').update(JSON.stringify([u.id,u.tenant_id,u.role,u.phone,u.password_hash,u.pin_hash])).digest('hex')
  }
  forget() { this.deps.write(null); this.locked = true }
  private current(): { lease: Lease; user: RememberedUser } | null {
    try {
      const stored = this.deps.read()
      if (!stored) return null
      const lease: Lease = JSON.parse(this.deps.decrypt(stored))
      const now = this.now()
      if (!Number.isFinite(lease.expires) || !Number.isFinite(lease.issued) || now < lease.issued
        || lease.expires <= now || lease.expires - lease.issued !== DAY
        || !Number.isInteger(lease.attempts) || lease.attempts < 0 || lease.attempts >= 5) throw Error('Expired')
      const user = this.deps.user(lease.id, lease.tenant)
      if (!user || user.is_active !== 1 || user.deleted_at || user.role === 'tire_worker'
        || (this.needsPin() && !user.pin_hash) || !user.password_hash || this.fingerprint(user) !== lease.fingerprint) throw Error('Revoked')
      return { lease, user }
    } catch { this.forget(); return null }
  }
  remember(user: RememberedUser) {
    if ((this.needsPin() && !user.pin_hash) || !user.password_hash || user.is_active !== 1 || user.deleted_at || user.role === 'tire_worker') throw Error('Доступ недоступний')
    const issued = this.now()
    const lease: Lease = { id:user.id, tenant:user.tenant_id, fingerprint:this.fingerprint(user), issued, expires:issued+DAY, attempts:0 }
    this.deps.write(this.deps.encrypt(JSON.stringify(lease)))
    this.locked = false
  }
  lock() { this.locked = true }
  status() {
    const current = this.current()
    return current ? { phone:current.user.phone, name:current.user.full_name, expiresAt:current.lease.expires, locked:this.needsPin() && this.locked } : null
  }
  unlock(pin: string) {
    const current = this.current()
    if (!current) throw Error('Збережений доступ завершено. Увійдіть із паролем')
    const { user, lease } = current
    // Persist failed attempts before verifying, including across process restarts.
    lease.attempts++
    this.deps.write(this.deps.encrypt(JSON.stringify(lease)))
    if (this.needsPin() && (!/^\d{4}$/.test(pin) || !verifySecret(user.pin_hash, pin, user.id))) {
      if (lease.attempts >= 5) this.forget()
      throw Error(lease.attempts >= 5 ? '5 невдалих спроб. Увійдіть із паролем' : 'Невірний PIN-код')
    }
    lease.attempts = 0
    this.deps.write(this.deps.encrypt(JSON.stringify(lease)))
    this.locked = false
    return { id:user.id, tenant_id:user.tenant_id, role:user.role, phone:user.phone, full_name:user.full_name,
      email:`${user.phone.replace(/\D/g,'')}@forsage.internal`, is_active:true }
  }
}
