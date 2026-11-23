import { createHash } from 'node:crypto'
import { localAccessDay } from './rememberedAccess'
import { checkedServerTokens, type ServerTokens } from './serverSession'

/**
 * Швидка зміна касира за PIN (етап 9; рішення власника 22.11.2026 «быстрый вход по пин»).
 * Пароль лишається основним входом: PIN діє лише для того, хто сьогодні вже входив паролем на цьому ПК.
 * Опівночі (за Києвом), після зміни пароля/ролі/телефону, звільнення або 3 невірних PIN поспіль —
 * знову потрібен пароль. Список зберігається зашифрованим сховищем Windows, як і денний вхід.
 */
export interface PinRosterUser {
  id: string; tenant_id: string; role: string; phone: string; full_name: string
  password_hash: string; pin_hash?: string | null; is_active: number; deleted_at: string | null
}
interface Entry { id: string; tenant: string; fingerprint: string; day: string; server?: ServerTokens }
interface Dependencies {
  read: () => string | null; write: (value: string | null) => void
  encrypt: (text: string) => string; decrypt: (text: string) => string
  user: (id: string, tenant: string) => PinRosterUser | null
  now?: () => number
}
export const PIN_FAILURES_BEFORE_PASSWORD = 3
/** 23.11.2026, рішення власника: за PIN — касири й менеджери; власник і адміністратор — лише паролем. */
export const PIN_ROLES: readonly string[] = ['cashier', 'manager']
/** Вхід за PIN без вибору працівника: стільки невірних PIN поспіль — і PIN на цьому ПК вимкнено на кілька хвилин. */
export const PIN_FAILURES_BEFORE_PAUSE = 5
export const PIN_PAUSE_MS = 5 * 60_000

export class PinRoster {
  private failures = new Map<string, number>()
  private anonymous = { failures: 0, pausedUntil: 0 }
  constructor(private readonly deps: Dependencies) {}
  private now() { return (this.deps.now ?? Date.now)() }
  private fingerprint(u: PinRosterUser) {
    return createHash('sha256').update(JSON.stringify(['pin-roster', u.id, u.tenant_id, u.role, u.phone, u.password_hash])).digest('hex')
  }
  private load(): Entry[] {
    try {
      const stored = this.deps.read()
      if (!stored) return []
      const parsed = JSON.parse(this.deps.decrypt(stored)) as { version?: number; entries?: Entry[] }
      return parsed.version === 1 && Array.isArray(parsed.entries) ? parsed.entries : []
    } catch { return [] }
  }
  private save(entries: Entry[]) {
    this.deps.write(entries.length ? this.deps.encrypt(JSON.stringify({ version: 1, entries })) : null)
  }
  private valid(entry: Entry, today: string): PinRosterUser | null {
    if (entry.day !== today) return null
    const user = this.deps.user(entry.id, entry.tenant)
    if (!user || user.is_active !== 1 || user.deleted_at || user.role === 'tire_worker' || !user.password_hash) return null
    return this.fingerprint(user) === entry.fingerprint ? user : null
  }
  private live(): Array<{ entry: Entry; user: PinRosterUser }> {
    const today = localAccessDay(this.now())
    const all = this.load()
    const live = all.flatMap(entry => { const user = this.valid(entry, today); return user ? [{ entry, user }] : [] })
    if (live.length !== all.length) this.save(live.map(item => item.entry))
    return live
  }
  /** Лише після успішної перевірки пароля в main-процесі. */
  rememberPasswordLogin(user: PinRosterUser) {
    if (!user.password_hash || user.is_active !== 1 || user.deleted_at || user.role === 'tire_worker') return
    const entry: Entry = { id: user.id, tenant: user.tenant_id, fingerprint: this.fingerprint(user), day: localAccessDay(this.now()) }
    this.failures.delete(user.tenant_id + ':' + user.id)
    this.save([...this.live().map(item => item.entry).filter(item => !(item.id === entry.id && item.tenant === entry.tenant)), entry])
  }
  /** Кого можна перемкнути PIN-ом: сьогодні входили паролем і мають PIN. Без хешів і телефонів. */
  list(): Array<{ id: string; full_name: string; role: string }> {
    return this.live().filter(item => Boolean(item.user.pin_hash) && PIN_ROLES.includes(item.user.role))
      .map(item => ({ id: item.user.id, full_name: item.user.full_name, role: item.user.role }))
  }
  /** Перевіряє PIN через verify; true — можна завершити вхід цього працівника. */
  login(id: string, tenant: string, verify: () => { valid: boolean; error?: string }): PinRosterUser {
    const item = this.live().find(candidate => candidate.entry.id === id && candidate.entry.tenant === tenant)
    if (!item) throw new Error('Сьогодні цей працівник ще не входив паролем на цьому ПК. Увійдіть паролем.')
    if (!item.user.pin_hash) throw new Error('PIN-код не налаштовано. Увійдіть паролем.')
    const key = tenant + ':' + id
    const result = verify()
    if (result.valid) { this.failures.delete(key); return item.user }
    const failures = (this.failures.get(key) ?? 0) + 1
    if (failures >= PIN_FAILURES_BEFORE_PASSWORD) {
      this.failures.delete(key)
      this.save(this.live().map(live => live.entry).filter(entry => !(entry.id === id && entry.tenant === tenant)))
      throw new Error('Невірний PIN кілька разів поспіль. Увійдіть паролем.')
    }
    this.failures.set(key, failures)
    throw new Error(result.error || 'Невірний PIN-код')
  }
  /**
   * 23.11.2026, рішення власника: «ввів свій PIN і зайшов — навіщо когось вибирати». Працівника визначає сам PIN
   * серед тих, хто сьогодні вже входив паролем на цьому ПК. `owners` повертає id тих із переданих, чий це PIN.
   */
  loginByPin(owners: (candidateIds: string[]) => string[]): PinRosterUser {
    const paused = 'Забагато невірних PIN. Увійдіть паролем або спробуйте через кілька хвилин.'
    if (this.anonymous.pausedUntil > this.now()) throw new Error(paused)
    const candidates = this.live().filter(item => Boolean(item.user.pin_hash) && PIN_ROLES.includes(item.user.role))
    const matched = candidates.length ? owners(candidates.map(item => item.user.id)) : []
    if (matched.length > 1) throw new Error('Цей PIN мають кілька працівників. Увійдіть паролем і змініть PIN.')
    const item = matched.length === 1 ? candidates.find(candidate => candidate.user.id === matched[0]) : undefined
    if (item) {
      this.anonymous = { failures: 0, pausedUntil: 0 }
      this.failures.delete(item.user.tenant_id + ':' + item.user.id)
      return item.user
    }
    const failures = this.anonymous.failures + 1
    if (failures >= PIN_FAILURES_BEFORE_PAUSE) {
      this.anonymous = { failures: 0, pausedUntil: this.now() + PIN_PAUSE_MS }
      throw new Error(paused)
    }
    this.anonymous = { failures, pausedUntil: 0 }
    // Одна відповідь і на невірний PIN, і на «сьогодні ще не входив паролем»: не підказуємо, чий PIN існує.
    throw new Error('PIN не підійшов. Якщо сьогодні ви ще не входили паролем — увійдіть паролем.')
  }
  /** Серверна сесія цього працівника на сьогодні — щоб після PIN обмін із сервером ішов без пароля. */
  saveServerSession(id: string, tenant: string, tokens: ServerTokens) {
    const entries = this.live().map(item => item.entry)
    const entry = entries.find(item => item.id === id && item.tenant === tenant)
    if (!entry) return
    entry.server = checkedServerTokens(tokens)
    this.save(entries)
  }
  serverSession(id: string, tenant: string): ServerTokens | null {
    const entry = this.live().find(item => item.entry.id === id && item.entry.tenant === tenant)?.entry
    if (!entry?.server) return null
    try { return checkedServerTokens(entry.server) } catch { return null }
  }
  forgetAll() { this.failures.clear(); this.anonymous = { failures: 0, pausedUntil: 0 }; this.save([]) }
}
