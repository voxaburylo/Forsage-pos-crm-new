import crypto from 'node:crypto'

// Секрет для шифрування чутливих значень (наприклад, API-ключа Gemini).
// Беремо окремий AI_KEY_SECRET, а якщо його немає — падаємо на JWT-секрет проекту,
// щоб не вимагати додаткового налаштування середовища на старті.
const SECRET =
  process.env.AI_KEY_SECRET ||
  process.env.SUPABASE_JWT_SECRET ||
  process.env.JWT_SECRET ||
  'forsage-ai-dev-fallback-secret-change-me'

// scrypt → стабільний 32-байтний ключ для AES-256.
const KEY = crypto.scryptSync(SECRET, 'forsage-ai-key-v1', 32)

/**
 * Шифрує рядок (AES-256-GCM). Формат: v1:<iv>:<tag>:<ciphertext> (усе base64).
 */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
}

/**
 * Розшифровує рядок, створений encryptSecret. Кидає помилку на пошкоджених даних.
 */
export function decryptSecret(payload: string): string {
  const parts = payload.split(':')
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Невірний формат зашифрованого значення')
  }
  const [, ivB, tagB, dataB] = parts
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB, 'base64'))
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()])
  return dec.toString('utf8')
}
