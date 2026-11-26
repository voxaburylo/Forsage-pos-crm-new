import type { LocalDatabase } from '../db/localDatabase'

/**
 * 24.11.2026 (рішення власника): права працівника — перемикачами в його картці, а не лише роллю.
 * Перемикач лише ДОДАЄ право понад роль (забрати те, що дає роль, ним не можна — для цього змінюють роль).
 * Зберігає й видає головний ПК: і своїй касі, і ПК менеджера, і вебу — одна правда.
 *  - orders          — розділ «Замовлення»: оформлення й ведення замовлень клієнтів;
 *  - purchase_prices — закупівельна ціна в картці товару (бачить і може змінити);
 *  - reports         — «Аналітика → Статистика» (обороти, залишки, борги; прибуток лишається власнику).
 */
// 26.11.2026 (власник: «зробити доступ до списання в картці менеджера»): writeoffs — «Склад → Списання» (акт списання).
export const STAFF_RIGHTS = ['orders', 'purchase_prices', 'reports', 'writeoffs'] as const
export type StaffRight = typeof STAFF_RIGHTS[number]
export type StaffRights = Record<StaffRight, boolean>

const KEY = 'staff-rights:v1'
/** Що роль дає сама, без перемикачів (так програма працювала до 24.11.2026). */
const BY_ROLE: Record<StaffRight, readonly string[]> = {
  orders: ['owner', 'admin', 'manager'],
  purchase_prices: ['owner', 'admin', 'storekeeper'],
  reports: ['owner', 'admin', 'manager'],
  writeoffs: ['owner', 'admin', 'storekeeper'],
}
/** Кому перемикач має сенс: роль із входом у програму, якій право не дане роллю. */
const SWITCHABLE: Record<StaffRight, readonly string[]> = {
  orders: ['cashier', 'storekeeper'],
  purchase_prices: ['cashier', 'manager'],
  reports: ['cashier'],
  writeoffs: ['manager'],
}

/** Дії, що створюють списання: менеджеру — лише з перемикачем «Списує товар». */
export const WRITEOFF_CREATE_CHANNELS = new Set(['desktop:warehouse:create-writeoff'])

type Stored = Record<string, Partial<Record<StaffRight, boolean>>>

function read(db: LocalDatabase): Stored {
  const row = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(KEY) as { value_json: string } | undefined
  if (!row) return {}
  try {
    const parsed = JSON.parse(row.value_json) as { users?: unknown }
    if (!parsed.users || typeof parsed.users !== 'object' || Array.isArray(parsed.users)) return {}
    const result: Stored = {}
    for (const [id, value] of Object.entries(parsed.users as Record<string, unknown>)) {
      if (!/^[a-zA-Z0-9-]{1,128}$/.test(id) || !value || typeof value !== 'object') continue
      const rights: Partial<Record<StaffRight, boolean>> = {}
      for (const right of STAFF_RIGHTS) if ((value as Record<string, unknown>)[right] === true) rights[right] = true
      if (Object.keys(rights).length) result[id] = rights
    }
    return result
  } catch { return {} }
}

export function isStaffRight(value: unknown): value is StaffRight {
  return typeof value === 'string' && (STAFF_RIGHTS as readonly string[]).includes(value)
}

/** Права працівника: те, що дає роль, плюс увімкнене власником. */
export function effectiveStaffRights(db: LocalDatabase, userId: string, role: string): StaffRights {
  const own = read(db)[userId] ?? {}
  const result = {} as StaffRights
  for (const right of STAFF_RIGHTS) result[right] = BY_ROLE[right].includes(role) || (SWITCHABLE[right].includes(role) && own[right] === true)
  return result
}

/** Для картки працівника: права кожного працівника. */
export function allStaffRights(db: LocalDatabase): Record<string, StaffRights> {
  const users = db.prepare('SELECT id, role FROM staff_users WHERE deleted_at IS NULL').all() as Array<{ id: string; role: string }>
  return Object.fromEntries(users.map(user => [user.id, effectiveStaffRights(db, user.id, user.role)]))
}

export function setStaffRight(db: LocalDatabase, userId: unknown, right: unknown, enabled: unknown): StaffRights {
  if (typeof userId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(userId)) throw new Error('Некоректний працівник')
  if (!isStaffRight(right)) throw new Error('Некоректне право')
  if (typeof enabled !== 'boolean') throw new Error('Некоректне значення дозволу')
  const user = db.prepare('SELECT role FROM staff_users WHERE id=? AND deleted_at IS NULL').get(userId) as { role: string } | undefined
  if (!user) throw new Error('Працівника не знайдено')
  if (BY_ROLE[right].includes(user.role)) throw new Error('Це право працівник уже має за своєю роллю')
  if (!SWITCHABLE[right].includes(user.role)) throw new Error('Для цієї ролі таке право не вмикається — змініть роль працівника')
  const stored = read(db)
  const own = { ...(stored[userId] ?? {}) }
  if (enabled) own[right] = true; else delete own[right]
  if (Object.keys(own).length) stored[userId] = own; else delete stored[userId]
  db.prepare(`INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
    .run(KEY, JSON.stringify({ users: stored }), new Date().toISOString())
  return effectiveStaffRights(db, userId, user.role)
}
