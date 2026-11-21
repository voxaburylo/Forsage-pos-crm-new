import type { LocalDatabase } from '../db/localDatabase'

/**
 * 21.11.2026 (рішення власника): «Може продавати» для менеджера вмикає власник у «Команда та ЗП».
 * Дозвіл зберігається в базі головного ПК: продаж і зміна з ПК менеджера теж виконуються тут.
 * За замовчуванням вимкнено — менеджер працює з товаром, приходом, ревізією і замовленнями.
 */
const KEY = 'manager-sale-access:v1'

function readIds(db: LocalDatabase): string[] {
  const row = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(KEY) as { value_json: string } | undefined
  if (!row) return []
  try {
    const parsed = JSON.parse(row.value_json) as { ids?: unknown }
    return Array.isArray(parsed.ids) ? parsed.ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128) : []
  } catch { return [] }
}

export function managerSaleAllowedIds(db: LocalDatabase): string[] {
  return readIds(db)
}

export function managerCanSell(db: LocalDatabase, userId: string): boolean {
  return readIds(db).includes(userId)
}

export function setManagerSaleAccess(db: LocalDatabase, userId: string, enabled: boolean): string[] {
  if (typeof userId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(userId)) throw new Error('Некоректний працівник')
  if (typeof enabled !== 'boolean') throw new Error('Некоректне значення дозволу')
  const user = db.prepare('SELECT role FROM staff_users WHERE id=? AND deleted_at IS NULL').get(userId) as { role: string } | undefined
  if (!user) throw new Error('Працівника не знайдено')
  if (user.role !== 'manager') throw new Error('Дозвіл на продаж вмикається лише менеджеру')
  const ids = new Set(readIds(db))
  if (enabled) ids.add(userId); else ids.delete(userId)
  const next = [...ids].sort()
  db.prepare(`INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
    .run(KEY, JSON.stringify({ ids: next }), new Date().toISOString())
  return next
}

export const MANAGER_SALE_DENIED = 'Продаж для менеджера вимкнено. Власник вмикає його в «Команда та ЗП» → картка менеджера → «Може продавати».'
