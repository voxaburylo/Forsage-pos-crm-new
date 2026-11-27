import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { LanSession } from './localNetwork'
import { decodeRpcValue, encodeRpcValue } from '../link/rpcCodec'

/**
 * Телефон через Wi-Fi без інтернету (27.11.2026, слово власника: «якщо застосунок в одній мережі з головним ПК по Wi-Fi —
 * щоб можна було працювати без інтернету»).
 *
 * Телефон говорить із головним ПК тим самим захищеним каналом, що й ПК менеджера (/forsage-lan/secure, AES-GCM), але
 * окремим «кодом для телефонів»: код ПК менеджера видано одному працівнику, а телефоном користуються різні люди.
 * Тому код телефона лише відкриває канал, а хто працює — визначає вхід паролем (його перевіряє головний ПК). Після входу
 * телефон отримує тимчасовий ключ сеансу. Кожна дія виконується тим самим шляхом і з тими самими правами, що й дія
 * вебу через сервер (executeWebRequest): касир — лише з дозволом «Працює через веб», комірник і шиномонтажник — ні.
 */
export const PHONE_ACCESS_FILE = 'lan-phone.json'
export const PHONE_SESSION_MS = 14 * 60 * 60_000
const MAX_SESSIONS = 200

export interface PhoneUser { id: string; tenant_id: string; role: string; full_name: string; phone: string }
export interface PhoneAccessServices {
  authenticate: (phone: string, password: string) => unknown | Promise<unknown>
  resolveSession: (userId: string) => LanSession | null
  /** Той самий виконавець, що й для вебу через сервер: права, дозвіл касира, перелік дозволених дій. */
  execute: (userId: string, channel: string, args: unknown[]) => Promise<unknown>
}

/** Що бачить власник у налаштуваннях головного ПК: адреси, порт і код (для QR-коду на екрані). */
export interface PhoneAccessStatus { enabled: boolean; key: string | null; addresses: string[]; port: number; hub: boolean }
export function phoneAccessStatus(access: PhoneLanAccess, lan: { mode: string; addresses: string[]; port: number } | undefined): PhoneAccessStatus {
  const key = access.key()
  return { enabled: Boolean(key), key, addresses: lan?.addresses ?? [], port: lan?.port ?? 0, hub: lan?.mode === 'hub' }
}
export function changePhoneAccess(access: PhoneLanAccess, action: unknown): void {
  if (action === 'enable') access.enable()
  else if (action === 'rotate') access.rotate()
  else if (action === 'disable') access.disable()
  else throw new Error('Невідома дія')
}

const isKey = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)

export class PhoneLanAccess {
  private sessions = new Map<string, { userId: string; expires: number }>()
  private cached: string | null | undefined

  constructor(private readonly dataRoot: string, private readonly services: PhoneAccessServices, private readonly now: () => number = Date.now) {}

  private file() { return path.join(this.dataRoot, PHONE_ACCESS_FILE) }

  /** Код для телефонів або null (вимкнено). */
  key(): string | null {
    if (this.cached !== undefined) return this.cached
    try {
      const parsed = JSON.parse(readFileSync(this.file(), 'utf8')) as { key?: unknown }
      this.cached = isKey(parsed.key) ? parsed.key : null
    } catch { this.cached = null }
    return this.cached
  }

  private save(key: string | null) {
    writeFileSync(this.file(), JSON.stringify({ key, changed_at: new Date(this.now()).toISOString() }, null, 2), 'utf8')
    this.cached = key
    this.sessions.clear()
  }

  /** Увімкнути (код лишається тим самим, якщо вже був). */
  enable(): string { return this.key() ?? this.rotate() }
  /** Новий код: усі телефони треба підключити знову (наприклад, загубили телефон). */
  rotate(): string { const key = randomBytes(16).toString('hex'); this.save(key); return key }
  disable(): void { this.save(null) }

  private sessionUser(token: unknown): string {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Увійдіть на телефоні знову')
    const entry = this.sessions.get(token)
    if (!entry || entry.expires < this.now()) { this.sessions.delete(token); throw new Error('Сеанс на телефоні закінчився — увійдіть знову') }
    return entry.userId
  }

  async dispatch(payload: unknown): Promise<unknown> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Некоректна мережева команда')
    const input = payload as Record<string, unknown>
    if (input.action === 'phone-probe') return { service: 'forsage-lan', phone: 1 }
    if (input.action === 'phone-login') {
      const phone = typeof input.phone === 'string' ? input.phone : ''
      if (phone.length > 64 || typeof input.password !== 'string' || !input.password || input.password.length > 1024) throw new Error('Введіть пароль')
      const profile = await this.services.authenticate(phone, input.password) as Partial<PhoneUser> & { is_active?: unknown } | null
      const session = profile && typeof profile.id === 'string' ? this.services.resolveSession(profile.id) : null
      if (!profile || !session || profile.is_active !== true || session.role === 'tire_worker') throw new Error('Працівник не знайдений або заблокований на головному ПК')
      for (const [token, entry] of this.sessions) if (entry.expires < this.now()) this.sessions.delete(token)
      while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string)
      const token = randomBytes(32).toString('hex')
      this.sessions.set(token, { userId: session.id, expires: this.now() + PHONE_SESSION_MS })
      const user: PhoneUser = { id: session.id, tenant_id: session.tenant_id, role: session.role,
        full_name: typeof profile.full_name === 'string' ? profile.full_name.slice(0, 300) : '',
        phone: typeof profile.phone === 'string' && profile.phone ? profile.phone.slice(0, 64) : phone }
      return { token, expires_at: new Date(this.now() + PHONE_SESSION_MS).toISOString(), user }
    }
    if (input.action === 'phone-logout') {
      if (typeof input.token === 'string') this.sessions.delete(input.token)
      return { ok: true }
    }
    if (input.action === 'phone-rpc') {
      const userId = this.sessionUser(input.token)
      // Працівника могли заблокувати після входу — перевіряємо при кожній дії.
      if (!this.services.resolveSession(userId)) { this.sessions.delete(String(input.token)); throw new Error('Працівник не знайдений або заблокований на головному ПК') }
      if (typeof input.channel !== 'string' || input.channel.length > 200) throw new Error('Некоректна мережева команда')
      // Дані — у тому ж вигляді, що й через сервер (байти фото — base64 з міткою): веб кодує однаково для обох шляхів.
      const args = decodeRpcValue(input.args)
      if (!Array.isArray(args)) throw new Error('Некоректна мережева команда')
      return encodeRpcValue((await this.services.execute(userId, input.channel, args)) ?? null)
    }
    throw new Error('Команду не знайдено')
  }
}
