import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

export const LAN_BOOTSTRAP_VERSION = 1 as const
export const SECURE_MAX_BYTES = 8 * 1024 * 1024
export const SECURE_MAX_WIRE_BYTES = 12 * 1024 * 1024
export const SECURE_LIFETIME_MS = 35_000
type Direction = 'request' | 'response'
export interface SecureEnvelope {
  version: 1; hubNonce: string; requestId: string; deadline: number; iv: string; data: string; tag: string
}
export function secureNonce(): string { return randomBytes(16).toString('hex') }
export function lanRequestContext(hubNonce: string, serverTime: unknown): Pick<SecureEnvelope, 'hubNonce' | 'requestId' | 'deadline'> {
  if (!/^[a-f0-9]{32}$/.test(hubNonce) || !Number.isSafeInteger(serverTime) || Number(serverTime) <= 0 || Number(serverTime) > 8_640_000_000_000_000 - SECURE_LIFETIME_MS) throw new Error('LAN_SECURE_INVALID')
  // Trust is established only by the encrypted reply; public time affects expiry,
  // never authorization. The hub independently enforces its actual current clock.
  return { hubNonce, requestId: secureNonce(), deadline: Number(serverTime) + 30_000 }
}
export function normalizeConnectCode(value: unknown): string {
  const code = String(value ?? '').trim().toLowerCase()
  if (!/^[a-f0-9]{32}$/.test(code)) throw new Error('Вкажіть 32-значний код підключення з головного ПК')
  return code
}
function key(code: string, hubNonce: string, direction: Direction) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(normalizeConnectCode(code), 'hex'), Buffer.from(hubNonce, 'hex'), `forsage-lan/bootstrap/1/${direction}`, 32))
}
function aad(envelope: Pick<SecureEnvelope, 'hubNonce' | 'requestId' | 'deadline'>, direction: Direction) {
  return Buffer.from(JSON.stringify(['forsage-lan', 1, 'POST', '/forsage-lan/secure', direction, envelope.hubNonce, envelope.requestId, envelope.deadline]))
}
function bytes(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('LAN_SECURE_INVALID')
  const result = Buffer.from(value, 'base64')
  if (result.toString('base64') !== value || (length !== undefined && result.length !== length)) throw new Error('LAN_SECURE_INVALID')
  return result
}
export function sealLanEnvelope(value: unknown, code: string, direction: Direction, context: Pick<SecureEnvelope, 'hubNonce' | 'requestId' | 'deadline'>): SecureEnvelope {
  const raw = Buffer.from(JSON.stringify(value), 'utf8')
  if (raw.length > SECURE_MAX_BYTES) throw new Error('LAN_SECURE_TOO_LARGE')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(code, context.hubNonce, direction), iv, { authTagLength: 16 })
  cipher.setAAD(aad(context, direction))
  const data = Buffer.concat([cipher.update(raw), cipher.final()])
  return { version: LAN_BOOTSTRAP_VERSION, ...context, iv: iv.toString('base64'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}
export function openLanEnvelope(value: unknown, code: string, direction: Direction, expected: { hubNonce: string; requestId?: string; deadline?: number }, now = Date.now()): { envelope: SecureEnvelope; value: unknown } {
  const envelope = value as SecureEnvelope
  if (!envelope || envelope.version !== LAN_BOOTSTRAP_VERSION || !/^[a-f0-9]{32}$/.test(envelope.hubNonce) || envelope.hubNonce !== expected.hubNonce
    || !/^[a-f0-9]{32}$/.test(envelope.requestId) || (expected.requestId !== undefined && envelope.requestId !== expected.requestId)
    || !Number.isSafeInteger(envelope.deadline) || envelope.deadline < now || envelope.deadline > now + SECURE_LIFETIME_MS
    || (expected.deadline !== undefined && envelope.deadline !== expected.deadline)
    || typeof envelope.data !== 'string' || envelope.data.length > Math.ceil(SECURE_MAX_BYTES / 3) * 4) throw new Error('LAN_SECURE_INVALID')
  const decipher = createDecipheriv('aes-256-gcm', key(code, envelope.hubNonce, direction), bytes(envelope.iv, 12), { authTagLength: 16 })
  decipher.setAAD(aad(envelope, direction)); decipher.setAuthTag(bytes(envelope.tag, 16))
  // Never parse/use unauthenticated plaintext: final() must succeed first.
  const plain = Buffer.concat([decipher.update(bytes(envelope.data)), decipher.final()])
  return { envelope, value: JSON.parse(plain.toString('utf8')) }
}

/** Bounded, fail-closed within one hub challenge; restarting rotates that challenge. */
export class LanReplayGuard {
  private readonly seen = new Map<string, number>()
  constructor(private readonly capacity = 4096) {}
  claim(id: string, deadline: number, now = Date.now()): void {
    for (const [key, expiry] of this.seen) if (expiry < now) this.seen.delete(key)
    if (this.seen.has(id) || this.seen.size >= this.capacity) throw new Error('LAN_REPLAY_REJECTED')
    this.seen.set(id, deadline)
  }
}
