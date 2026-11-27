import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { LanSession } from './localNetwork'
import { decodeRpcValue, encodeRpcValue } from '../link/rpcCodec'

/**
 * Телефон через Wi-Fi без інтернету (27.11.2026, слово власника: «якщо застосунок в одній мережі з головним ПК по Wi-Fi —
 * щоб можна було працювати без інтернету» і далі «щоб нічого не сканувати: пропав інтернет — працюємо офлайн автоматом»).
 *
 * Телефон говорить із головним ПК тим самим захищеним каналом, що й ПК менеджера (/forsage-lan/secure, AES-GCM), але
 * окремим «кодом для телефонів»: код ПК менеджера видано одному працівнику, а телефоном користуються різні люди.
 * Тому код телефона лише відкриває канал, а хто працює — визначає сеанс працівника:
 *  - автоматично: поки є інтернет, працівник, що вже увійшов у застосунок (сервер + головний ПК підтвердили, хто це),
 *    отримує від головного ПК адресу, код і свій сеанс Wi-Fi (issueFor) — нічого сканувати й вводити не треба;
 *  - вручну: QR-код у налаштуваннях головного ПК і пароль працівника (phone-login).
 * Кожна дія виконується тим самим шляхом і з тими самими правами, що й дія вебу через сервер (executeWebRequest):
 * касир — лише з дозволом «Працює через веб», шиномонтажник — ні. Сеанси зберігаються лише як відбитки (sha256).
 */
export const PHONE_ACCESS_FILE = 'lan-phone.json'
export const PHONE_SESSION_MS = 30 * 24 * 60 * 60_000
const MAX_SESSIONS = 300

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

/** Що отримує телефон через сервер, поки є інтернет: куди йти без інтернету, чим відкрити канал і свій сеанс. */
export interface PhoneWifiPairing { hosts: string[]; port: number; key: string; token: string; expires_at: string; user: PhoneUser }

const isKey = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
const digest = (token: string) => createHash('sha256').update(token).digest('hex')
type Session = { userId: string; expires: number }
type Stored = { key: string | null; sessions: Record<string, Session> }

export class PhoneLanAccess {
  private state: Stored | null = null

  constructor(private readonly dataRoot: string, private readonly services: PhoneAccessServices, private readonly now: () => number = Date.now) {}

  private file() { return path.join(this.dataRoot, PHONE_ACCESS_FILE) }

  private load(): Stored {
    if (this.state) return this.state
    let parsed: { key?: unknown; sessions?: unknown } = {}
    try { parsed = JSON.parse(readFileSync(this.file(), 'utf8')) } catch { /* ще не вмикали */ }
    const sessions: Record<string, Session> = {}
    if (parsed.sessions && typeof parsed.sessions === 'object') {
      for (const [hash, value] of Object.entries(parsed.sessions as Record<string, Partial<Session>>)) {
        if (/^[a-f0-9]{64}$/.test(hash) && typeof value?.userId === 'string' && Number.isFinite(value.expires)) sessions[hash] = { userId: value.userId, expires: Number(value.expires) }
      }
    }
    this.state = { key: isKey(parsed.key) ? parsed.key : null, sessions }
    return this.state
  }

  private persist() {
    const state = this.load()
    const now = this.now()
    for (const [hash, entry] of Object.entries(state.sessions)) if (entry.expires < now) delete state.sessions[hash]
    writeFileSync(this.file(), JSON.stringify({ key: state.key, sessions: state.sessions, changed_at: new Date(now).toISOString() }, null, 2), 'utf8')
  }

  /** Код для телефонів або null (вимкнено). */
  key(): string | null { return this.load().key }

  /** Увімкнути (код лишається тим самим, якщо вже був). */
  enable(): string { return this.key() ?? this.rotate() }
  /** Новий код: усі телефони відʼєднуються (наприклад, загубили телефон); з інтернетом вони підключаться самі. */
  rotate(): string { const key = randomBytes(16).toString('hex'); this.state = { key, sessions: {} }; this.persist(); return key }
  disable(): void { this.state = { key: null, sessions: {} }; this.persist() }

  private newSession(userId: string): { token: string; expires_at: string } {
    const state = this.load()
    const hashes = Object.keys(state.sessions)
    for (const hash of hashes.slice(0, Math.max(0, hashes.length - MAX_SESSIONS + 1))) delete state.sessions[hash]
    const token = randomBytes(32).toString('hex')
    const expires = this.now() + PHONE_SESSION_MS
    state.sessions[digest(token)] = { userId, expires }
    this.persist()
    return { token, expires_at: new Date(expires).toISOString() }
  }

  private sessionUser(token: unknown): string {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Увійдіть на телефоні знову')
    const state = this.load(), hash = digest(token), entry = state.sessions[hash]
    if (!entry || entry.expires < this.now()) { if (entry) { delete state.sessions[hash]; this.persist() } throw new Error('Сеанс на телефоні закінчився — увійдіть знову') }
    return entry.userId
  }

  /**
   * Автоматичне підключення телефона: працівника вже підтвердили сервер і головний ПК (запит прийшов від його імені).
   * Вмикає доступ телефонів, якщо ще не ввімкнено, і видає сеанс саме цьому працівнику.
   */
  issueFor(session: LanSession, profile: { full_name?: string; phone?: string } | null, lan: { mode: string; addresses: string[]; port: number } | undefined): PhoneWifiPairing {
    if (lan?.mode !== 'hub') throw new Error('Цей ПК не є головним ПК мережі')
    if (!this.services.resolveSession(session.id) || session.role === 'tire_worker') throw new Error('Працівник не знайдений або заблокований на головному ПК')
    const key = this.enable()
    const { token, expires_at } = this.newSession(session.id)
    return { hosts: lan.addresses.slice(0, 8), port: lan.port, key, token, expires_at,
      user: { id: session.id, tenant_id: session.tenant_id, role: session.role, full_name: String(profile?.full_name ?? '').slice(0, 300), phone: String(profile?.phone ?? '').slice(0, 64) } }
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
      const user: PhoneUser = { id: session.id, tenant_id: session.tenant_id, role: session.role,
        full_name: typeof profile.full_name === 'string' ? profile.full_name.slice(0, 300) : '',
        phone: typeof profile.phone === 'string' && profile.phone ? profile.phone.slice(0, 64) : phone }
      return { ...this.newSession(session.id), user }
    }
    if (input.action === 'phone-logout') {
      if (typeof input.token === 'string') { const state = this.load(); delete state.sessions[digest(input.token)]; this.persist() }
      return { ok: true }
    }
    if (input.action === 'phone-rpc') {
      const userId = this.sessionUser(input.token)
      // Працівника могли заблокувати після входу — перевіряємо при кожній дії.
      if (!this.services.resolveSession(userId)) { delete this.load().sessions[digest(String(input.token))]; this.persist(); throw new Error('Працівник не знайдений або заблокований на головному ПК') }
      if (typeof input.channel !== 'string' || input.channel.length > 200) throw new Error('Некоректна мережева команда')
      // Дані — у тому ж вигляді, що й через сервер (байти фото — base64 з міткою): веб кодує однаково для обох шляхів.
      const args = decodeRpcValue(input.args)
      if (!Array.isArray(args)) throw new Error('Некоректна мережева команда')
      return encodeRpcValue((await this.services.execute(userId, input.channel, args)) ?? null)
    }
    throw new Error('Команду не знайдено')
  }
}
