/**
 * 22.11.2026: запит вебу до головного ПК їде через сервер у JSON. Байти (фото накладної, фото товару)
 * JSON не переносить — кодуємо їх у base64 з міткою і відновлюємо на тому боці.
 */
const BYTES = '__forsage_bytes'
const DATE = '__forsage_date'

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function encodeRpcValue(value: unknown, depth = 0): unknown {
  if (depth > 40) throw new Error('Занадто вкладені дані для передачі на касу')
  if (value instanceof ArrayBuffer) return { [BYTES]: toBase64(new Uint8Array(value)) }
  if (ArrayBuffer.isView(value)) return { [BYTES]: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) }
  if (value instanceof Date) return { [DATE]: value.toISOString() }
  if (Array.isArray(value)) return value.map(item => encodeRpcValue(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeRpcValue(item, depth + 1)]))
  if (typeof value === 'function') throw new Error('Цю дію не можна передати на касу з вебу')
  return value
}

/** Байти повертаються як ArrayBuffer — так їх чекає IPC каси й екрани. */
export function decodeRpcValue(value: unknown, depth = 0): unknown {
  if (depth > 40) return value
  if (Array.isArray(value)) return value.map(item => decodeRpcValue(item, depth + 1))
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length === 1 && keys[0] === BYTES && typeof record[BYTES] === 'string') {
      const bytes = fromBase64(record[BYTES] as string)
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    }
    if (keys.length === 1 && keys[0] === DATE && typeof record[DATE] === 'string') return new Date(record[DATE] as string)
    return Object.fromEntries(keys.map(key => [key, decodeRpcValue(record[key], depth + 1)]))
  }
  return value
}
