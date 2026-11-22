import type { LocalDatabase } from '../db/localDatabase'

/**
 * 21.11.2026 (рішення власника): «Може продавати» для менеджера вмикає власник у «Команда та ЗП».
 * Дозвіл зберігається в базі головного ПК: продаж і зміна з ПК менеджера теж виконуються тут.
 * За замовчуванням вимкнено — менеджер працює з товаром, приходом, ревізією і замовленнями.
 */
const KEY = 'manager-sale-access:v1'

/**
 * 22.11.2026 (рішення власника): окремий дозвіл «Може приймати задаток» у картці менеджера.
 * Менеджер із цим дозволом відкриває й закриває свою зміну та приймає передоплату/оплату замовлень,
 * але не продає з каси, не робить повернень і касових операцій — на це потрібен «Може продавати».
 */
const DEPOSIT_KEY = 'manager-deposit-access:v1'

function readIds(db: LocalDatabase, key: string = KEY): string[] {
  const row = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(key) as { value_json: string } | undefined
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

export function managerDepositAllowedIds(db: LocalDatabase): string[] {
  return readIds(db, DEPOSIT_KEY)
}

export function managerCanTakeDeposit(db: LocalDatabase, userId: string): boolean {
  return readIds(db, DEPOSIT_KEY).includes(userId)
}

export function setManagerDepositAccess(db: LocalDatabase, userId: string, enabled: boolean): string[] {
  return writeAccess(db, DEPOSIT_KEY, userId, enabled, 'Дозвіл приймати задаток вмикається лише менеджеру')
}

export function setManagerSaleAccess(db: LocalDatabase, userId: string, enabled: boolean): string[] {
  return writeAccess(db, KEY, userId, enabled, 'Дозвіл на продаж вмикається лише менеджеру')
}

function writeAccess(db: LocalDatabase, key: string, userId: string, enabled: boolean, notManager: string): string[] {
  if (typeof userId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(userId)) throw new Error('Некоректний працівник')
  if (typeof enabled !== 'boolean') throw new Error('Некоректне значення дозволу')
  const user = db.prepare('SELECT role FROM staff_users WHERE id=? AND deleted_at IS NULL').get(userId) as { role: string } | undefined
  if (!user) throw new Error('Працівника не знайдено')
  if (user.role !== 'manager') throw new Error(notManager)
  const ids = new Set(readIds(db, key))
  if (enabled) ids.add(userId); else ids.delete(userId)
  const next = [...ids].sort()
  db.prepare(`INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
    .run(key, JSON.stringify({ ids: next }), new Date().toISOString())
  return next
}

export const MANAGER_DEPOSIT_ONLY = 'Вам дозволено лише приймати задаток і оплату за замовленнями. Продаж, повернення й касові операції власник вмикає в «Команда та ЗП» → картка менеджера → «Може продавати».'
export const MANAGER_SALE_DENIED = 'Продаж для менеджера вимкнено. Власник вмикає його в «Команда та ЗП» → картка менеджера → «Може продавати».'
