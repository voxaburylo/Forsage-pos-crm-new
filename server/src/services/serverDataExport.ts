import { pool } from '../db/pg.js'
import { listAiRules } from './aiMemoryService.js'

/**
 * Копія даних, які живуть лише в хмарі (22.11.2026, «каса головна; сервер — передавач і копія»).
 *
 * Усе робоче — товари, чеки, накладні — живе на касі й копіюється з її базою. Але лист очікування, сповіщення,
 * канали й листування, посилання на прайс, пороги тривог і правила помічника є тільки на сервері, а хмарна база
 * на безкоштовному тарифі сама не копіюється. Головний ПК раз на добу забирає ці дані своїм ключем зв'язку
 * і кладе у власну базу — так вони потрапляють у кожну її копію (на диску, на флешці, у хмарі).
 *
 * Ключі й паролі сторонніх служб у копію НЕ потрапляють: їх після відновлення вводять заново.
 */
export const SERVER_ONLY_TABLES: readonly string[] = [
  'product_waitlist', 'in_app_notifications', 'notification_templates', 'customer_notification_preferences',
  'messenger_channels', 'messenger_chats', 'telegram_messages', 'price_list_links', 'auto_purchase_rules',
  'staff_kpi_targets', 'shop_settings',
]
/** Рядків на таблицю: дані службові й малі; обмеження — щоб копія не розрослася через помилку. */
export const SERVER_DATA_ROW_LIMIT = 5_000
export const SECRET_FIELD = /credential|token|secret|password|(^|_)pin($|_)|api_key|license_key|key_encrypted/i
export const SECRET_PLACEHOLDER = '[не зберігається в копії]'

/** Прибирає ключі й паролі на будь-якій глибині; решту лишає як є. */
export function withoutSecrets(value: unknown, depth = 0): unknown {
  if (depth > 20 || value === null || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(item => withoutSecrets(item, depth + 1))
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) =>
    [key, SECRET_FIELD.test(key) && item !== null && item !== '' ? SECRET_PLACEHOLDER : withoutSecrets(item, depth + 1)]))
}

export async function exportServerOnlyData(tenantId: string, now: Date = new Date()) {
  const tables: Record<string, unknown[]> = {}
  const errors: Record<string, string> = {}
  const read = async (name: string, sql: string) => {
    try { tables[name] = (await pool.query(sql, [tenantId, SERVER_DATA_ROW_LIMIT])).rows.map(row => withoutSecrets(row)) }
    catch (error) { errors[name] = (error instanceof Error ? error.message : String(error)).slice(0, 200) }
  }
  // Імена таблиць — лише з переліку вище, не ззовні.
  for (const name of SERVER_ONLY_TABLES) await read(name, `SELECT * FROM public.${name} WHERE tenant_id = $1 LIMIT $2`)
  await read('messenger_messages', `SELECT m.* FROM public.messenger_messages m JOIN public.messenger_chats c ON c.id = m.chat_id WHERE c.tenant_id = $1 ORDER BY m.created_at DESC LIMIT $2`)
  let aiRules: unknown = []
  try { aiRules = await listAiRules(tenantId) } catch (error) { errors.ai_rules = (error instanceof Error ? error.message : String(error)).slice(0, 200) }
  return { version: 1, exported_at: now.toISOString(), tenant_id: tenantId, tables, ai_rules: aiRules, errors }
}
