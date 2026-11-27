import { CapacitorHttp } from '@capacitor/core'
import { decodeRpcValue, encodeRpcValue } from '@/lib/tillRpcCodec'
import { isNativeApp } from '@/lib/nativeScan'
import { newRequestId, normalizePhoneCode, openEnvelope, sealEnvelope } from './envelope'

/**
 * Телефон працює з головним ПК через Wi-Fi, без інтернету (27.11.2026, слово власника: «якщо застосунок в одній мережі
 * з головним ПК по Wi-Fi — щоб можна було працювати без інтернету» і «щоб нічого не сканувати: пропав інтернет — працюємо
 * офлайн автоматом»).
 *
 * Автоматично: поки є інтернет, застосунок від імені того, хто увійшов, отримує від головного ПК (через сервер) його
 * адреси в мережі, код каналу й власний сеанс Wi-Fi (phoneWifiAutoSetup.ts). Пропав інтернет — застосунок відкриває
 * копію екранів, вбудовану в нього, і сам входить цим сеансом: кожна дія йде прямо на головний ПК тим самим захищеним
 * каналом, що й у ПК менеджера, з тими самими правами, що й дія вебу через сервер.
 * Вручну (запасний шлях): QR-код у налаштуваннях головного ПК і пароль працівника.
 *
 * Без інтернету працюють екрани, які працюють через головний ПК (каса, повернення, гроші, товари, клієнти, замовлення);
 * те, що живе лише на сервері (ШІ, сайт, постачальники), — ні.
 *
 * Зберігається в памʼяті самого телефона (Preferences), а не сторінки: звичайна версія (з сервера) і копія в застосунку
 * мають різні адреси, і памʼять сторінки в них різна. localStorage — лише швидка копія для синхронних перевірок.
 */
export const PHONE_LAN_STORAGE = 'forsage.phone-lan'
const BOOTSTRAP_TIMEOUT_MS = 4_000
const CALL_TIMEOUT_MS = 40_000
const REACHABLE_MEMORY_MS = 15_000

export interface PhonePairing { hosts: string[]; port: number; key: string }
export interface PhoneLanUser { id: string; tenant_id: string; role: string; full_name: string; phone: string }
export interface PhoneLanStored { pairing: PhonePairing; token?: string; expires_at?: string; user?: PhoneLanUser; refreshed_at?: string }

const PRIVATE_HOST = /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/
const privateHost = (host: string) => PRIVATE_HOST.test(host) && host.split('.').every(part => Number(part) <= 255)

export function validPairing(value: unknown): PhonePairing {
  const input = (value ?? {}) as Record<string, unknown>
  const raw = Array.isArray(input.hosts) ? input.hosts : [input.host]
  const hosts = [...new Set(raw.map(host => String(host ?? '').trim()).filter(privateHost))].slice(0, 8)
  const port = Number(input.port)
  if (!hosts.length) throw new Error('Адреса головного ПК — локальна, наприклад 192.168.1.10')
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Некоректний порт головного ПК')
  return { hosts, port, key: normalizePhoneCode(input.key) }
}

/** QR-код із головного ПК: forsage-phone:192.168.1.10:47821:<32 знаки коду>. */
export const PHONE_QR_PREFIX = 'forsage-phone:'
export function phoneQrText(pairing: { host: string; port: number; key: string }): string { return `${PHONE_QR_PREFIX}${pairing.host}:${pairing.port}:${pairing.key}` }
export function parsePhoneQr(text: string): PhonePairing {
  const raw = String(text ?? '').trim()
  if (!raw.startsWith(PHONE_QR_PREFIX)) throw new Error('Це не QR-код «Телефони через Wi-Fi» з головного ПК')
  const [host, port, key] = raw.slice(PHONE_QR_PREFIX.length).split(':')
  return validPairing({ host, port: Number(port), key })
}

function parseStored(text: string | null): PhoneLanStored | null {
  try {
    const stored = JSON.parse(text ?? 'null') as PhoneLanStored | null
    return stored ? { ...stored, pairing: validPairing(stored.pairing) } : null
  } catch { return null }
}
function read(): PhoneLanStored | null {
  try { return parseStored(localStorage.getItem(PHONE_LAN_STORAGE)) } catch { return null }
}
function write(stored: PhoneLanStored | null) {
  const text = stored ? JSON.stringify(stored) : null
  try { if (text) localStorage.setItem(PHONE_LAN_STORAGE, text); else localStorage.removeItem(PHONE_LAN_STORAGE) } catch { /* optional */ }
  reachable = null
  if (isNativeApp()) void import('@capacitor/preferences').then(({ Preferences }) => text ? Preferences.set({ key: PHONE_LAN_STORAGE, value: text }) : Preferences.remove({ key: PHONE_LAN_STORAGE })).catch(() => undefined)
}

/** Перед першим екраном: перенести збережене з памʼяті телефона в швидку копію цієї сторінки. */
export async function hydratePhoneLan(): Promise<void> {
  if (!isNativeApp()) return
  try {
    const { Preferences } = await import('@capacitor/preferences')
    const { value } = await Preferences.get({ key: PHONE_LAN_STORAGE })
    if (parseStored(value)) localStorage.setItem(PHONE_LAN_STORAGE, value as string)
  } catch { /* без памʼяті телефона — лише ручний вхід */ }
}

export function phoneLanStored(): PhoneLanStored | null { return read() }
export function phonePairing(): PhonePairing | null { return read()?.pairing ?? null }
export function savePhonePairing(pairing: PhonePairing): void { write({ pairing: validPairing(pairing) }) }
export function savePhoneLanAccess(stored: PhoneLanStored): void { write({ ...stored, pairing: validPairing(stored.pairing) }) }
export function forgetPhonePairing(): void { write(null) }

/** Є дійсний сеанс Wi-Fi (його можна використати, коли пропаде інтернет). */
export function phoneLanActive(now = Date.now()): boolean {
  const stored = read()
  return Boolean(stored?.token && stored.expires_at && Date.parse(stored.expires_at) > now)
}
export function phoneLanUser(): PhoneLanUser | null { return phoneLanActive() ? read()?.user ?? null : null }

/** Застосунок зараз працює через Wi-Fi (вхід через головний ПК, без сервера): дії й перевірки йдуть прямо на ПК. */
let viaWifi = false
export function phoneWorksViaWifi(): boolean { return viaWifi && phoneLanActive() }
export function setPhoneWorksViaWifi(on: boolean): void { viaWifi = on }

type HttpAnswer = { status: number; data: unknown }
async function http(url: string, method: 'GET' | 'POST', body: unknown, timeoutMs: number): Promise<HttpAnswer> {
  // У застосунку — рідний запит телефона: сторінка застосунку захищена (https), а головний ПК у мережі — http.
  if (isNativeApp()) {
    const answer = await CapacitorHttp.request({ url, method, headers: { 'Content-Type': 'application/json' }, data: body,
      connectTimeout: Math.min(timeoutMs, BOOTSTRAP_TIMEOUT_MS), readTimeout: timeoutMs, responseType: 'json' })
    return { status: answer.status, data: typeof answer.data === 'string' ? JSON.parse(answer.data || 'null') : answer.data }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal })
    return { status: response.status, data: await response.json().catch(() => null) }
  } finally { clearTimeout(timer) }
}

type Hello = { host: string; nonce: string; serverTime: number }
async function hello(pairing: PhonePairing): Promise<Hello> {
  // Головний ПК може мати кілька адрес (Wi-Fi, кабель, віртуальні адаптери) — пробуємо по черзі, вдала стає першою.
  for (const host of pairing.hosts) {
    let answer: HttpAnswer
    try { answer = await http(`http://${host}:${pairing.port}/forsage-lan/bootstrap`, 'GET', undefined, BOOTSTRAP_TIMEOUT_MS) } catch { continue }
    const info = answer.data as { service?: unknown; nonce?: unknown; serverTime?: unknown } | null
    if (answer.status !== 200 || info?.service !== 'forsage-lan' || typeof info.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(info.nonce) || !Number.isSafeInteger(info.serverTime)) continue
    if (host !== pairing.hosts[0]) {
      const stored = read()
      if (stored && stored.pairing.key === pairing.key) write({ ...stored, pairing: { ...stored.pairing, hosts: [host, ...stored.pairing.hosts.filter(other => other !== host)] } })
    }
    return { host, nonce: info.nonce, serverTime: Number(info.serverTime) }
  }
  throw new Error('Головний ПК не відповідає. Перевірте, що телефон у тій самій мережі Wi-Fi, а програма на касі відкрита.')
}

/** Один захищений запит до головного ПК (експортовано для перевірки зі справжнім головним ПК у тестах). */
export async function secureCall(pairing: PhonePairing, payload: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
  const hi = await hello(pairing)
  const context = { hubNonce: hi.nonce, requestId: newRequestId(), deadline: hi.serverTime + 30_000 }
  const answer = await http(`http://${hi.host}:${pairing.port}/forsage-lan/secure`, 'POST', await sealEnvelope(payload, pairing.key, 'request', context), timeoutMs)
  if (answer.status === 401) throw new Error('Головний ПК не прийняв код телефона. Відкрийте застосунок з інтернетом — він підключиться сам.')
  const opened = await openEnvelope(answer.data, pairing.key, 'response', context) as { ok?: unknown; result?: unknown; error?: unknown }
  if (opened?.ok !== true) throw new Error(typeof opened?.error === 'string' ? opened.error : 'Головний ПК не виконав дію')
  return opened.result
}

let reachable: { at: number; ok: boolean } | null = null
/** Чи відповідає головний ПК через Wi-Fi (відповідь памʼятається кілька секунд). */
export async function phoneLanReachable(now = Date.now()): Promise<boolean> {
  const pairing = phonePairing()
  if (!pairing) return false
  if (reachable && now - reachable.at < REACHABLE_MEMORY_MS) return reachable.ok
  const ok = await secureCall(pairing, { action: 'phone-probe' }, BOOTSTRAP_TIMEOUT_MS).then(() => true, () => false)
  reachable = { at: Date.now(), ok }
  return ok
}

/** Перевірити адресу й код одразу після сканування — до збереження. */
export async function checkPhonePairing(pairing: PhonePairing): Promise<void> { await secureCall(validPairing(pairing), { action: 'phone-probe' }, BOOTSTRAP_TIMEOUT_MS) }

export async function phoneLanLogin(password: string, phone = ''): Promise<PhoneLanUser> {
  const stored = read()
  if (!stored) throw new Error('Телефон ще не знає головного ПК. Відкрийте застосунок з інтернетом і увійдіть — далі він підключиться сам.')
  const result = await secureCall(stored.pairing, { action: 'phone-login', phone, password }) as { token?: unknown; expires_at?: unknown; user?: PhoneLanUser }
  if (typeof result?.token !== 'string' || typeof result.expires_at !== 'string' || !result.user?.id) throw new Error('Головний ПК не підтвердив вхід')
  write({ pairing: stored.pairing, token: result.token, expires_at: result.expires_at, user: result.user })
  return result.user
}

export async function phoneLanLogout(): Promise<void> {
  const stored = read()
  viaWifi = false
  if (!stored) return
  write({ pairing: stored.pairing })
  if (stored.token) await secureCall(stored.pairing, { action: 'phone-logout', token: stored.token }, BOOTSTRAP_TIMEOUT_MS).catch(() => undefined)
}

/** Одна дія екрана на головному ПК — так само, як через сервер (/api/v1/till-rpc), лише напряму. */
export async function phoneLanCall(channel: string, args: unknown[]): Promise<unknown> {
  const stored = read()
  if (!stored?.token) throw new Error('Увійдіть на телефоні через Wi-Fi знову')
  const result = await secureCall(stored.pairing, { action: 'phone-rpc', token: stored.token, channel, args: encodeRpcValue(args) })
  return decodeRpcValue(result)
}
