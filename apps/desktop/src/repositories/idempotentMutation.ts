import { createHash } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  return value
}

// Receipt and business write share one transaction; failed work never leaves a receipt.
export function idempotentMutation<T>(db: LocalDatabase, scope: string, operationId: string, payload: unknown, work: () => T): T {
  const key = 'mutation:' + scope + ':' + operationId
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex')
  return db.transaction(() => {
    const row = db.prepare('SELECT value_json FROM app_meta WHERE key = ?').get(key) as { value_json: string } | undefined
    if (row) {
      const saved = JSON.parse(row.value_json)
      if (saved.fingerprint !== fingerprint) throw new Error('Повтор операції містить інші дані. Запис не виконано.')
      return saved.result as T
    }
    const result = work()
    db.prepare('INSERT INTO app_meta(key, value_json, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify({ fingerprint, result }), new Date().toISOString())
    return result
  })
}
