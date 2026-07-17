import type { Session } from '@supabase/supabase-js'

// Офлайн-вхід для desktop-каси. Після першого УСПІШНОГО онлайн-входу зберігаємо
// локально хеш пароля (PBKDF2) + останню валідну сесію. Далі, коли інтернету нема
// (війна, відключення світла), касир входить за цим кешем — пароль перевіряється
// локально, роль і сесія відновлюються з кешу. Пароль у відкритому вигляді НЕ
// зберігається. Сесія й так лежить у localStorage через supabase-js, тож нового
// секрету ми не додаємо — лише незворотний хеш пароля.

const STORE_KEY = 'forsage_offline_auth_v1'
const PBKDF2_ITERATIONS = 150_000
const MAX_CACHED_USERS = 8

interface CachedCredential {
  emailKey: string
  salt: string // base64
  hash: string // base64
  session: Session
  cachedAt: string
}

function toB64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function fromB64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
}

async function derivePasswordHash(password: string, salt: Uint8Array): Promise<string> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256,
  )
  return toB64(new Uint8Array(bits))
}

function readAll(): CachedCredential[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]')
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function writeAll(list: CachedCredential[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, MAX_CACHED_USERS)))
  } catch {
    // localStorage може бути недоступний — офлайн-вхід просто не працюватиме
  }
}

// Порівняння в постійний час, щоб не давати підказок таймінгом
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function cacheCredential(emailKey: string, password: string, session: Session): Promise<void> {
  if (typeof crypto?.subtle === 'undefined') return
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derivePasswordHash(password, salt)
  const record: CachedCredential = {
    emailKey,
    salt: toB64(salt),
    hash,
    session,
    cachedAt: new Date().toISOString(),
  }
  const list = readAll().filter((r) => r.emailKey !== emailKey)
  list.unshift(record)
  writeAll(list)
}

export async function verifyOfflineCredential(emailKey: string, password: string): Promise<Session | null> {
  if (typeof crypto?.subtle === 'undefined') return null
  const record = readAll().find((r) => r.emailKey === emailKey)
  if (!record) return null
  const hash = await derivePasswordHash(password, fromB64(record.salt))
  return constantTimeEqual(hash, record.hash) ? record.session : null
}

export function hasAnyOfflineCredential(): boolean {
  return readAll().length > 0
}

/** Остання збережена сесія — для тихого відновлення на холодному старті,
 * коли Supabase не може відповісти (нема інтернету, протухлий токен). */
export function loadLastCachedSession(): Session | null {
  const record = readAll()[0]
  return record ? record.session : null
}

// Оновлюємо збережену сесію (напр. після авто-refresh токена онлайн),
// не чіпаючи хеш пароля — щоб офлайн-вхід лишався валідним.
export function refreshCachedSession(emailKey: string, session: Session): void {
  const list = readAll()
  const record = list.find((r) => r.emailKey === emailKey)
  if (!record) return
  record.session = session
  record.cachedAt = new Date().toISOString()
  writeAll(list)
}
