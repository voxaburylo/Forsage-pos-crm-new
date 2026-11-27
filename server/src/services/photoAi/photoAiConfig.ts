import { z } from 'zod'
import { pool } from '../../db/pg.js'
import { decryptSecret, encryptSecret } from '../../lib/crypto.js'

/**
 * «Пошук фото з ШІ»: налаштування, ключі й лічильник платних запитів.
 * Ключі Serper.dev і Gemini вставляє власник; лежать зашифрованими в закритій таблиці, назовні видно лише кінець ключа.
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
export const keysSchema = z.object({ serper_key: keyText.optional(), gemini_key: keyText.optional() })

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

export interface PhotoAiKeys { serper: string | null; gemini: string | null }
export async function readKeys(tenantId: string): Promise<PhotoAiKeys> {
  const row = (await pool.query('SELECT serper_key_encrypted, gemini_key_encrypted FROM photo_ai_settings WHERE tenant_id = $1', [tenantId])).rows[0]
  return { serper: open(row?.serper_key_encrypted), gemini: open(row?.gemini_key_encrypted) }
}

/** Назовні — лише «ключ є» і його останні 4 знаки. */
export const keyHint = (key: string | null) => key ? '…' + key.slice(-4) : ''
export async function keysState(tenantId: string) {
  const keys = await readKeys(tenantId)
  return { serper: Boolean(keys.serper), serper_hint: keyHint(keys.serper), gemini: Boolean(keys.gemini), gemini_hint: keyHint(keys.gemini) }
}

export async function saveKeys(tenantId: string, userId: string | null, input: z.infer<typeof keysSchema>) {
  await pool.query('INSERT INTO photo_ai_settings (tenant_id, updated_by) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING', [tenantId, userId])
  if (input.serper_key !== undefined) await pool.query('UPDATE photo_ai_settings SET serper_key_encrypted = $2, updated_by = $3, updated_at = now() WHERE tenant_id = $1',
    [tenantId, input.serper_key ? encryptSecret(input.serper_key) : null, userId])
  if (input.gemini_key !== undefined) await pool.query('UPDATE photo_ai_settings SET gemini_key_encrypted = $2, updated_by = $3, updated_at = now() WHERE tenant_id = $1',
    [tenantId, input.gemini_key ? encryptSecret(input.gemini_key) : null, userId])
  return keysState(tenantId)
}

export interface PhotoCalls { serper: number; gemini: number }
export async function addUsage(tenantId: string, calls: PhotoCalls): Promise<void> {
  if (!calls.serper && !calls.gemini) return
  await pool.query(
    `INSERT INTO photo_ai_usage (tenant_id, day, serper_calls, gemini_calls) VALUES ($1, (now() AT TIME ZONE 'Europe/Kyiv')::date, $2, $3)
     ON CONFLICT (tenant_id, day) DO UPDATE SET serper_calls = photo_ai_usage.serper_calls + EXCLUDED.serper_calls, gemini_calls = photo_ai_usage.gemini_calls + EXCLUDED.gemini_calls`,
    [tenantId, calls.serper, calls.gemini])
}

export async function readUsage(tenantId: string) {
  const row = (await pool.query(
    `SELECT COALESCE(sum(serper_calls) FILTER (WHERE day = (now() AT TIME ZONE 'Europe/Kyiv')::date), 0)::int AS serper_today,
            COALESCE(sum(gemini_calls) FILTER (WHERE day = (now() AT TIME ZONE 'Europe/Kyiv')::date), 0)::int AS gemini_today,
            COALESCE(sum(serper_calls), 0)::int AS serper_month, COALESCE(sum(gemini_calls), 0)::int AS gemini_month
       FROM photo_ai_usage WHERE tenant_id = $1 AND day > (now() AT TIME ZONE 'Europe/Kyiv')::date - 30`, [tenantId])).rows[0]
  return { serper_today: row?.serper_today ?? 0, gemini_today: row?.gemini_today ?? 0, serper_month: row?.serper_month ?? 0, gemini_month: row?.gemini_month ?? 0 }
}
