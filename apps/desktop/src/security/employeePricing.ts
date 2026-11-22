import type { LocalDatabase } from '../db/localDatabase'

/**
 * 22.11.2026 (рішення власника, етап 9): ціна для працівника задається в картці працівника —
 * або своя знижка у відсотках, або «за закупкою» (тоді відсоток не діє). Без запису в картці діє
 * загальна «Знижка для працівників» з налаштувань. Нижче закупівельної ціни каса не продає ніколи:
 * це стереже сам чек, а не ця настройка.
 * Зберігається в базі головного ПК, як і «Може продавати».
 */
export type EmployeePrice = { mode: 'pct'; pct: number } | { mode: 'cost' }
const KEY = 'employee-pricing:v1'
const ID = /^[a-zA-Z0-9-]{1,128}$/

function clean(value: unknown): EmployeePrice | null {
  const input = (value && typeof value === 'object' ? value : {}) as { mode?: unknown; pct?: unknown }
  if (input.mode === 'cost') return { mode: 'cost' }
  const pct = Number(input.pct)
  if (input.mode === 'pct' && Number.isFinite(pct) && pct >= 0 && pct <= 100) return { mode: 'pct', pct: Math.round(pct * 100) / 100 }
  return null
}

export function employeePricing(db: LocalDatabase): Record<string, EmployeePrice> {
  const row = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(KEY) as { value_json: string } | undefined
  if (!row) return {}
  try {
    const parsed = JSON.parse(row.value_json) as { users?: Record<string, unknown> }
    const result: Record<string, EmployeePrice> = {}
    for (const [id, value] of Object.entries(parsed.users ?? {})) {
      const price = clean(value)
      if (ID.test(id) && price) result[id] = price
    }
    return result
  } catch { return {} }
}

/** `null` прибирає особисту ціну: працівник знову отримує загальну знижку з налаштувань. */
export function setEmployeePricing(db: LocalDatabase, userId: string, value: unknown): Record<string, EmployeePrice> {
  if (typeof userId !== 'string' || !ID.test(userId)) throw new Error('Некоректний працівник')
  const price = value === null ? null : clean(value)
  if (value !== null && !price) throw new Error('Вкажіть знижку від 0 до 100 % або «за закупкою»')
  if (!db.prepare('SELECT id FROM staff_users WHERE id=? AND deleted_at IS NULL').get(userId)) throw new Error('Працівника не знайдено')
  const next = employeePricing(db)
  if (price) next[userId] = price; else delete next[userId]
  db.prepare(`INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
    .run(KEY, JSON.stringify({ users: next }), new Date().toISOString())
  return next
}
