import { createHash } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'

function canonical(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Некоректна кількість або сума. Запис не виконано.')
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  return value
}

// Receipt and business write share one transaction; failed work never leaves a receipt.
export function idempotentMutation<T>(db: LocalDatabase, scope: string, operationId: string, payload: unknown, work: () => T,
  captureVerification?: (result: T) => (() => void)): T {
  const key = 'mutation:' + scope + ':' + operationId
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex')
  return db.transaction(() => {
    const row = db.prepare('SELECT value_json FROM app_meta WHERE key = ?').get(key) as { value_json: string } | undefined
    if (row) {
      const saved = JSON.parse(row.value_json)
      if (saved.cancelled === true) throw new Error('Цю спробу вже закрито без проведення. Старий запит не виконано.')
      if (saved.fingerprint !== fingerprint) throw new Error('Повтор операції містить інші дані. Запис не виконано.')
      return saved.result as T
    }
    const result = work()
    // Capture verified business state before writing the final retry receipt.
    const verify = captureVerification?.(result)
    const valueJson = JSON.stringify({ fingerprint, result })
    const timestamp = new Date().toISOString()
    const inserted = db.prepare('INSERT INTO app_meta(key, value_json, updated_at) VALUES (?, ?, ?)').run(key, valueJson, timestamp)
    verify?.()
    const stored = db.prepare('SELECT value_json, updated_at FROM app_meta WHERE key=?').get(key) as { value_json: string; updated_at: string } | undefined
    if (inserted.changes !== 1 || !stored || stored.value_json !== valueJson || stored.updated_at !== timestamp)
      throw new Error('Не вдалося зберегти підтвердження операції. Зміни цієї спроби скасовано; повторіть дію.')
    return result
  })
}
