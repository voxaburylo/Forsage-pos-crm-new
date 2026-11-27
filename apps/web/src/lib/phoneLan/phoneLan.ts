import { CapacitorHttp } from '@capacitor/core'
import { decodeRpcValue, encodeRpcValue } from '@/lib/tillRpcCodec'
import { isNativeApp } from '@/lib/nativeScan'
import { newRequestId, normalizePhoneCode, openEnvelope, sealEnvelope } from './envelope'

/**
 * Телефон працює з головним ПК через Wi-Fi, без інтернету (27.11.2026, слово власника: «якщо застосунок в одній мережі
 * з головним ПК по Wi-Fi — щоб можна було працювати без інтернету»).
 *
 * Як це влаштовано: власник один раз показує на головному ПК QR-код («Налаштування» → «ПК і мережа» → «Телефони через
 * Wi-Fi»), телефон його сканує й запамʼятовує адресу та код. Працівник входить своїм паролем — його перевіряє головний ПК.
 * Далі кожна дія екрана йде прямо на головний ПК (той самий захищений канал, що й у ПК менеджера) і виконується з тими
 * самими правами, що й дія вебу через сервер. Без інтернету працюють екрани, які працюють через головний ПК (каса,
 * повернення, гроші, товари, клієнти, замовлення); те, що живе лише на сервері (ШІ, сайт, постачальники), — ні.
 */
export const PHONE_LAN_STORAGE = 'forsage.phone-lan'
const BOOTSTRAP_TIMEOUT_MS = 4_000
const CALL_TIMEOUT_MS = 40_000
const REACHABLE_MEMORY_MS = 15_000

export interface PhonePairing { host: string; port: number; key: string }
export interface PhoneLanUser { id: string; tenant_id: string; role: string; full_name: string; phone: string }
interface Stored { pairing: PhonePairing; token?: string; expires_at?: string; user?: PhoneLanUser }

const PRIVATE_HOST = /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/

export function validPairing(value: unknown): PhonePairing {
  const input = (value ?? {}) as Record<string, unknown>
  const host = String(input.host ?? '').trim()
  const port = Number(input.port)
  if (!PRIVATE_HOST.test(host) || host.split('.').some(part => Number(part) > 255)) throw new Error('Адреса головного ПК — локальна, наприклад 192.168.1.10')
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Некоректний порт головного ПК')
  return { host, port, key: normalizePhoneCode(input.key) }
}

/** QR-код із головного ПК: forsage-phone:192.168.1.10:47821:<32 знаки коду>. */
export const PHONE_QR_PREFIX = 'forsage-phone:'
export function phoneQrText(pairing: PhonePairing): string { return `${PHONE_QR_PREFIX}${pairing.host}:${pairing.port}:${pairing.key}` }
export function parsePhoneQr(text: string): PhonePairing {
  const raw = String(text ?? '').trim()
  if (!raw.startsWith(PHONE_QR_PREFIX)) throw new Error('Це не QR-код «Телефони через Wi-Fi» з головного ПК')
  const [host, port, key] = raw.slice(PHONE_QR_PREFIX.length).split(':')
  return validPairing({ host, port: Number(port), key })
}

function read(): Stored | null {
  try {
    const stored = JSON.parse(localStorage.getItem(PHONE_LAN_STORAGE) ?? 'null') as Stored | null
    if (!stored) return null
    return { ...stored, pairing: validPairing(stored.pairing) }
  } catch { return null }
}
function write(stored: Stored | null) {
  try { if (stored) localStorage.setItem(PHONE_LAN_STORAGE, JSON.stringify(stored)); else localStorage.removeItem(PHONE_LAN_STORAGE) } catch { /* optional */ }
  reachable = null
}

export function phonePairing(): PhonePairing | null { return read()?.pairing ?? null }
export function savePhonePairing(pairing: PhonePairing): void { write({ pairing: validPairing(pairing) }) }
export function forgetPhonePairing(): void { write(null) }

/** Працівник увійшов через Wi-Fi і сеанс ще дійсний — дії екранів ідуть прямо на головний ПК. */
export function phoneLanActive(now = Date.now()): boolean {
  const stored = read()
  return Boolean(stored?.token && stored.expires_at && Date.parse(stored.expires_at) > now)
}
export function phoneLanUser(): PhoneLanUser | null { return phoneLanActive() ? read()?.user ?? null : null }

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

/** Один захищений запит до головного ПК (експортовано для перевірки з справжнім головним ПК у тестах). */
export async function secureCall(pairing: PhonePairing, payload: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
  const base = `http://${pairing.host}:${pairing.port}/forsage-lan`
  let hello: HttpAnswer
  try { hello = await http(`${base}/bootstrap`, 'GET', undefined, BOOTSTRAP_TIMEOUT_MS) }
  catch { throw new Error('Головний ПК не відповідає. Перевірте, що телефон у тій самій мережі Wi-Fi, а програма на касі відкрита.') }
  const info = hello.data as { service?: unknown; nonce?: unknown; serverTime?: unknown } | null
  if (hello.status !== 200 || info?.service !== 'forsage-lan' || typeof info.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(info.nonce) || !Number.isSafeInteger(info.serverTime))
    throw new Error('За цією адресою не головний ПК Форсажу')
  const context = { hubNonce: info.nonce, requestId: newRequestId(), deadline: Number(info.serverTime) + 30_000 }
  const answer = await http(`${base}/secure`, 'POST', await sealEnvelope(payload, pairing.key, 'request', context), timeoutMs)
  if (answer.status === 401) throw new Error('Головний ПК не прийняв код телефона. Скануйте QR-код на головному ПК ще раз.')
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
  if (!stored) throw new Error('Спершу підключіть телефон до головного ПК (QR-код у налаштуваннях головного ПК)')
  const result = await secureCall(stored.pairing, { action: 'phone-login', phone, password }) as { token?: unknown; expires_at?: unknown; user?: PhoneLanUser }
  if (typeof result?.token !== 'string' || typeof result.expires_at !== 'string' || !result.user?.id) throw new Error('Головний ПК не підтвердив вхід')
  write({ pairing: stored.pairing, token: result.token, expires_at: result.expires_at, user: result.user })
  return result.user
}

export async function phoneLanLogout(): Promise<void> {
  const stored = read()
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
