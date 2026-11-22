/**
 * Той самий запис даних, що й у вебі (apps/web/src/lib/tillRpcCodec.ts): запит вебу до головного ПК їде
 * через сервер у JSON, а байти (фото накладної, фото товару) і дати JSON не переносить.
 * Тут — для головного процесу програми, який тепер сам забирає запити вебу (tillDeviceLink).
 * Мітки мусять збігатися з вебом; це стереже тест tillDeviceLink.test.ts.
 */
export const RPC_BYTES = '__forsage_bytes'
export const RPC_DATE = '__forsage_date'

export function encodeRpcValue(value: unknown, depth = 0): unknown {
  if (depth > 40) throw new Error('Занадто вкладені дані для передачі у веб')
  if (value instanceof ArrayBuffer) return { [RPC_BYTES]: Buffer.from(value).toString('base64') }
  if (ArrayBuffer.isView(value)) return { [RPC_BYTES]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') }
  if (value instanceof Date) return { [RPC_DATE]: value.toISOString() }
  if (Array.isArray(value)) return value.map(item => encodeRpcValue(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeRpcValue(item, depth + 1)]))
  if (typeof value === 'function') throw new Error('Цю відповідь не можна передати у веб')
  return value
}

/** Байти повертаються як ArrayBuffer — так їх отримують дії каси й через звичайний IPC. */
export function decodeRpcValue(value: unknown, depth = 0): unknown {
  if (depth > 40) return value
  if (Array.isArray(value)) return value.map(item => decodeRpcValue(item, depth + 1))
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length === 1 && keys[0] === RPC_BYTES && typeof record[RPC_BYTES] === 'string') {
      const bytes = Buffer.from(record[RPC_BYTES] as string, 'base64')
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    }
    if (keys.length === 1 && keys[0] === RPC_DATE && typeof record[RPC_DATE] === 'string') return new Date(record[RPC_DATE] as string)
    return Object.fromEntries(keys.map(key => [key, decodeRpcValue(record[key], depth + 1)]))
  }
  return value
}
