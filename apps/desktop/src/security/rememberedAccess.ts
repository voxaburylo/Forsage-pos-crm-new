import { createHash } from 'node:crypto'

export interface RememberedUser {
  id: string; tenant_id: string; role: string; phone: string; full_name: string
  password_hash: string; pin_hash?: string; is_active: number; deleted_at: string | null
}
interface Lease { version: 2; id: string; tenant: string; fingerprint: string; expires: number; issued: number; day: string }
interface Dependencies {
  read: () => string | null; write: (value: string | null) => void
  encrypt: (text: string) => string; decrypt: (text: string) => string
  user: (id: string, tenant: string) => RememberedUser | null
  now?: () => number
}
const businessDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' })
export function localAccessDay(timestamp: number): string { return businessDate.format(new Date(timestamp)) }
export function endOfAccessDay(timestamp: number): number {
  const day = localAccessDay(timestamp)
  // Calendar midnight, including the 23/25-hour DST days; independent of PC timezone.
  let low = Math.floor(timestamp), high = low + 26 * 60 * 60 * 1000
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (localAccessDay(middle) === day) low = middle
    else high = middle
  }
  return high
}
export class RememberedAccess {
  constructor(private readonly deps: Dependencies) {}
  private now() { return (this.deps.now ?? Date.now)() }
  private fingerprint(u: RememberedUser) {
    return createHash('sha256').update(JSON.stringify([u.id,u.tenant_id,u.role,u.phone,u.password_hash])).digest('hex')
  }
  forget() { this.deps.write(null) }
  private current(): { lease: Lease; user: RememberedUser } | null {
    try {
      const stored = this.deps.read()
      if (!stored) return null
      const lease: Lease = JSON.parse(this.deps.decrypt(stored))
      const now = this.now()
      if (lease.version !== 2 || !Number.isSafeInteger(lease.expires) || !Number.isSafeInteger(lease.issued)
        || now < lease.issued || lease.expires <= now || lease.expires !== endOfAccessDay(lease.issued)
        || lease.day !== localAccessDay(now) || lease.day !== localAccessDay(lease.issued)) throw Error('Expired')
      const user = this.deps.user(lease.id, lease.tenant)
      if (!user || user.is_active !== 1 || user.deleted_at || user.role === 'tire_worker'
        || !user.password_hash || this.fingerprint(user) !== lease.fingerprint) throw Error('Revoked')
      return { lease, user }
    } catch { this.forget(); return null }
  }
  // Called only by main after a successful password check, never by renderer input.
  remember(user: RememberedUser) {
    if (!user.password_hash || user.is_active !== 1 || user.deleted_at || user.role === 'tire_worker') throw Error('Доступ недоступний')
    const issued = this.now()
    const lease: Lease = { version:2, id:user.id, tenant:user.tenant_id, fingerprint:this.fingerprint(user), issued, expires:endOfAccessDay(issued), day:localAccessDay(issued) }
    this.deps.write(this.deps.encrypt(JSON.stringify(lease)))
  }
  status() {
    const current = this.current()
    return current ? { phone:current.user.phone, name:current.user.full_name, expiresAt:current.lease.expires } : null
  }
  restore() {
    const current = this.current()
    if (!current) return null
    const { user } = current
    return { id:user.id, tenant_id:user.tenant_id, role:user.role, phone:user.phone, full_name:user.full_name,
      email:`${user.phone.replace(/\D/g,'')}@forsage.internal`, is_active:true }
  }
}
