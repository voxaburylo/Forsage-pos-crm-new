import crypto from 'node:crypto'

const FORMAT = 'pbkdf2-sha512'
export const SECRET_HASH_ITERATIONS = 210_000
const KEY_BYTES = 64
const SALT_BYTES = 16

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

export function hashSecret(secret: string, iterations = SECRET_HASH_ITERATIONS): string {
  const salt = crypto.randomBytes(SALT_BYTES)
  const hash = crypto.pbkdf2Sync(secret, salt, iterations, KEY_BYTES, 'sha512')
  return `${FORMAT}$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function legacySecretHash(secret: string, legacySalt: string): string {
  return crypto.pbkdf2Sync(secret, legacySalt, 10_000, KEY_BYTES, 'sha512').toString('hex')
}


export function isSupportedSecretHash(stored: string | null | undefined): boolean {
  if (!stored) return false
  if (/^[0-9a-f]{128}$/i.test(stored)) return true
  const [format, iterationsText, saltText, hashText, ...extra] = stored.split('$')
  const iterations = Number(iterationsText)
  if (format !== FORMAT || extra.length > 0 || !Number.isInteger(iterations)) return false
  try {
    return iterations >= 10_000 && iterations <= 1_000_000
      && Buffer.from(saltText, 'base64').length >= 16
      && Buffer.from(hashText, 'base64').length === KEY_BYTES
  } catch {
    return false
  }
}
export function verifySecret(stored: string | null | undefined, secret: string, legacySalt: string): boolean {
  if (!stored) return false

  if (/^[0-9a-f]{128}$/i.test(stored)) {
    return safeEqual(Buffer.from(stored, 'hex'), Buffer.from(legacySecretHash(secret, legacySalt), 'hex'))
  }

  const [format, iterationsText, saltText, hashText, ...extra] = stored.split('$')
  if (format !== FORMAT || extra.length > 0) return false
  const iterations = Number(iterationsText)
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 1_000_000) return false

  try {
    const salt = Buffer.from(saltText, 'base64')
    const expected = Buffer.from(hashText, 'base64')
    if (salt.length < 16 || expected.length !== KEY_BYTES) return false
    const actual = crypto.pbkdf2Sync(secret, salt, iterations, expected.length, 'sha512')
    return safeEqual(actual, expected)
  } catch {
    return false
  }
}

export function secretHashNeedsUpgrade(stored: string | null | undefined): boolean {
  if (!stored) return true
  const [format, iterationsText] = stored.split('$')
  return format !== FORMAT || Number(iterationsText) < SECRET_HASH_ITERATIONS
}