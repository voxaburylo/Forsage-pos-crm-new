import { z } from 'zod'
import { pool } from '../../db/pg.js'
import { decryptSecret, encryptSecret } from '../../lib/crypto.js'

/**
 * «Пошук фото з ШІ»: налаштування, ключі й лічильник платних запитів.
 * Ключ Serper.dev вставляє власник; лежить зашифрованим у закритій таблиці, назовні видно лише кінець ключа.
 * Фото перевіряє помічник програми (Claude Sonnet) — його ключ Anthropic уже є в Налаштування → ШІ, окремого не потрібно.
 */
export interface PhotoAiSettings { photos_per_product: number; require_white: boolean; forbid_text: boolean; min_size: number; night_only: boolean }
export const DEFAULT_SETTINGS: PhotoAiSettings = { photos_per_product: 3, require_white: true, forbid_text: true, min_size: 600, night_only: false }

export const settingsSchema = z.object({
  photos_per_product: z.number().int().min(1).max(5),
  require_white: z.boolean(),
  forbid_text: z.boolean(),
  min_size: z.number().int().min(200).max(2000),
  night_only: z.boolean(),
})
/** Порожній рядок — прибрати ключ; поля немає — не чіпати. */
const keyText = z.string().trim().max(300).regex(/^[A-Za-z0-9_\-.]*$/, 'Ключ — лише латинські літери, цифри, «-», «_» і «.»')
export const keysSchema = z.object({ serper_key: keyText.optional() })

export async function readSettings(tenantId: string): Promise<PhotoAiSettings> {
  const row = (await pool.query('SELECT photos_per_product, require_white, forbid_text, min_size, night_only FROM photo_ai_settings WHERE tenant_id = $1', [tenantId])).rows[0]
  return row ? { photos_per_product: row.photos_per_product, require_white: row.require_white, forbid_text: row.forbid_text, min_size: row.min_size, night_only: row.night_only } : { ...DEFAULT_SETTINGS }
}

export async function saveSettings(tenantId: string, userId: string | null, input: PhotoAiSettings): Promise<PhotoAiSettings> {
  await pool.query(
    `INSERT INTO photo_ai_settings (tenant_id, photos_per_product, require_white, forbid_text, min_size, night_only, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id) DO UPDATE SET photos_per_product = EXCLUDED.photos_per_product, require_white = EXCLUDED.require_white,
       forbid_text = EXCLUDED.forbid_text, min_size = EXCLUDED.min_size, night_only = EXCLUDED.night_only, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [tenantId, input.photos_per_product, input.require_white, input.forbid_text, input.min_size, input.night_only, userId])
  return readSettings(tenantId)
}

const open = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value) return null
  try { return decryptSecret(value) } catch { return null }
}

/** ai — ключ Anthropic помічника (null, якщо ключа немає або помічник вимкнений); ai_model — його модель. */
export interface PhotoAiKeys { serper: string | null; ai: string | null; ai_model: string; tenant_id?: string }
export async function readKeys(tenantId: string): Promise<PhotoAiKeys> {
  const row = (await pool.query('SELECT serper_key_encrypted FROM photo_ai_settings WHERE tenant_id = $1', [tenantId])).rows[0]
  // Модуль помічника важкий — підвантажуємо лише тут.
  const assistant = await (await import('../aiService.js')).getAiConfig(tenantId).catch(() => null)
  return { serper: open(row?.serper_key_encrypted), ai: assistant?.enabled && assistant.apiKey ? assistant.apiKey : null, ai_model: assistant?.model ?? 'claude-sonnet-5-5', tenant_id: tenantId }
}

/** Назовні — лише «ключ є» і його останні 4 знаки. */
export const keyHint = (key: string | null) => key ? '…' + key.slice(-4) : ''
export async function keysState(tenantId: string) {
  const keys = await readKeys(tenantId)
  return { serper: Boolean(keys.serper), serper_hint: keyHint(keys.serper), ai: Boolean(keys.ai) }
}

export async function saveKeys(tenantId: string, userId: string | null, input: z.infer<typeof keysSchema>) {
  await pool.query('INSERT INTO photo_ai_settings (tenant_id, updated_by) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING', [tenantId, userId])
  if (input.serper_key !== undefined) await pool.query('UPDATE photo_ai_settings SET serper_key_encrypted = $2, updated_by = $3, updated_at = now() WHERE tenant_id = $1',
    [tenantId, input.serper_key ? encryptSecret(input.serper_key) : null, userId])
  return keysState(tenantId)
}

/** serper — запити пошуку, ai — перевірки фото помічником, usd — скільки ці перевірки коштували. */
export interface PhotoCalls { serper: number; ai: number; usd: number }
export async function addUsage(tenantId: string, calls: PhotoCalls): Promise<void> {
  if (!calls.serper && !calls.ai) return
  await pool.query(
    `INSERT INTO photo_ai_usage (tenant_id, day, serper_calls, ai_calls, ai_usd) VALUES ($1, (now() AT TIME ZONE 'Europe/Kyiv')::date, $2, $3, $4)
     ON CONFLICT (tenant_id, day) DO UPDATE SET serper_calls = photo_ai_usage.serper_calls + EXCLUDED.serper_calls, ai_calls = photo_ai_usage.ai_calls + EXCLUDED.ai_calls,
       ai_usd = photo_ai_usage.ai_usd + EXCLUDED.ai_usd`,
    [tenantId, calls.serper, calls.ai, calls.usd])
}

export async function readUsage(tenantId: string) {
  const row = (await pool.query(
    `SELECT COALESCE(sum(serper_calls) FILTER (WHERE day = (now() AT TIME ZONE 'Europe/Kyiv')::date), 0)::int AS serper_today,
            COALESCE(sum(ai_calls) FILTER (WHERE day = (now() AT TIME ZONE 'Europe/Kyiv')::date), 0)::int AS ai_today,
            COALESCE(sum(serper_calls), 0)::int AS serper_month, COALESCE(sum(ai_calls), 0)::int AS ai_month, COALESCE(sum(ai_usd), 0)::float AS usd_month
       FROM photo_ai_usage WHERE tenant_id = $1 AND day > (now() AT TIME ZONE 'Europe/Kyiv')::date - 30`, [tenantId])).rows[0]
  return { serper_today: row?.serper_today ?? 0, ai_today: row?.ai_today ?? 0, serper_month: row?.serper_month ?? 0, ai_month: row?.ai_month ?? 0, usd_month: Math.round((Number(row?.usd_month) || 0) * 100) / 100 }
}
