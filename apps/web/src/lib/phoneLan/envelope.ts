/**
 * Захищений конверт для телефона через Wi-Fi (27.11.2026). Байт у байт той самий, що й у головного ПК
 * (apps/desktop/src/lan/secureTransport.ts): ключ — HKDF-SHA256 із коду підключення й «nonce» головного ПК,
 * шифр — AES-256-GCM, у додаткових даних — призначення конверта. Тут — вбудована криптографія браузера (WebCrypto).
 */
export const LAN_BOOTSTRAP_VERSION = 1
export interface SecureEnvelope { version: 1; hubNonce: string; requestId: string; deadline: number; iv: string; data: string; tag: string }
type Direction = 'request' | 'response'
type Context = Pick<SecureEnvelope, 'hubNonce' | 'requestId' | 'deadline'>

const hex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], pair => parseInt(pair, 16))
const toHex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const out = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function normalizePhoneCode(value: unknown): string {
  const code = String(value ?? '').trim().toLowerCase()
  if (!/^[a-f0-9]{32}$/.test(code)) throw new Error('Код підключення — 32 знаки з головного ПК')
  return code
}

export function newRequestId(): string { return toHex(crypto.getRandomValues(new Uint8Array(16))) }

async function aesKey(code: string, hubNonce: string, direction: Direction): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', hex(normalizePhoneCode(code)), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: hex(hubNonce), info: new TextEncoder().encode(`forsage-lan/bootstrap/1/${direction}`) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
const aad = (context: Context, direction: Direction) =>
  new TextEncoder().encode(JSON.stringify(['forsage-lan', 1, 'POST', '/forsage-lan/secure', direction, context.hubNonce, context.requestId, context.deadline]))

export async function sealEnvelope(value: unknown, code: string, direction: Direction, context: Context): Promise<SecureEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(context, direction), tagLength: 128 },
    await aesKey(code, context.hubNonce, direction), new TextEncoder().encode(JSON.stringify(value))))
  // WebCrypto дописує мітку в кінець шифру, а головний ПК чекає її окремим полем.
  return { version: 1, ...context, iv: toBase64(iv), data: toBase64(sealed.subarray(0, sealed.length - 16)), tag: toBase64(sealed.subarray(sealed.length - 16)) }
}

export async function openEnvelope(value: unknown, code: string, direction: Direction, expected: Context): Promise<unknown> {
  const envelope = value as SecureEnvelope
  if (!envelope || envelope.version !== 1 || envelope.hubNonce !== expected.hubNonce || envelope.requestId !== expected.requestId || envelope.deadline !== expected.deadline
    || typeof envelope.iv !== 'string' || typeof envelope.data !== 'string' || typeof envelope.tag !== 'string') throw new Error('Головний ПК відповів не тим кодом')
  const data = fromBase64(envelope.data), tag = fromBase64(envelope.tag)
  const joined = new Uint8Array(data.length + tag.length)
  joined.set(data); joined.set(tag, data.length)
  let plain: ArrayBuffer
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: aad(envelope, direction), tagLength: 128 },
      await aesKey(code, envelope.hubNonce, direction), joined)
  } catch { throw new Error('Головний ПК відповів не тим кодом') }
  return JSON.parse(new TextDecoder().decode(plain))
}
