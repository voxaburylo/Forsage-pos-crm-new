import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'

/**
 * Пропуск самоперевірки сервера (див. selfCheckService). Поки триває перевірка, сервер сам звертається
 * до власних адрес читання від імені власника магазину. Пропуск — випадкове число, яке живе лише в пам'яті
 * цього процесу на час одного проходу й ніколи його не покидає, окрім заголовка запиту до самого себе.
 * Діє тільки для GET: змінити дані ним неможливо.
 */
export const SELF_CHECK_HEADER = 'x-forsage-self-check'

interface SelfCheckIdentity { id: string; email: string; role: string; tenant_id: string }
let active: { nonce: Buffer; identity: SelfCheckIdentity } | null = null

/** Відкрити пропуск на час проходу. Повертає значення заголовка. */
export function openSelfCheckPass(identity: SelfCheckIdentity): string {
  const nonce = randomBytes(32)
  active = { nonce, identity }
  return nonce.toString('hex')
}

export function closeSelfCheckPass(): void {
  active = null
}

/** Хто цей запит, якщо це самоперевірка; інакше null — і запит проходить звичайну авторизацію. */
export function selfCheckIdentity(req: Pick<Request, 'method' | 'headers'>): SelfCheckIdentity | null {
  if (!active || req.method !== 'GET') return null
  const header = req.headers[SELF_CHECK_HEADER]
  if (typeof header !== 'string' || !/^[0-9a-f]{64}$/.test(header)) return null
  const given = Buffer.from(header, 'hex')
  return given.length === active.nonce.length && timingSafeEqual(given, active.nonce) ? { ...active.identity } : null
}
