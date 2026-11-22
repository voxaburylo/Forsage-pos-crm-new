import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'

/**
 * Ключ зв'язку головного ПК (22.11.2026, «головний ПК — тимчасовий сервер магазину»).
 *
 * Запити вебу досі забирала сесія того, хто увійшов у програму на касі: вийшов касир — зв'язок зник.
 * Тепер сам ПК має ключ: програма забирає запити вебу й на екрані входу, після перезапуску, уночі.
 * Ключ дає рівно одне — бути передавачем між вебом і цим магазином (забрати запит, віддати відповідь).
 * Нічого в даних магазину ним змінити не можна: дію виконує каса у своїй базі з правами працівника з вебу.
 * На сервері лежить лише хеш; сам ключ видається один раз і зберігається в захищеному сховищі Windows.
 */
const uuid = z.string().uuid()
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

/** Видати (або замінити) ключ пристрою. Лише власник чи адміністратор, лише з програми на касі. */
export async function registerTillDevice(tenantId: string, userId: string, deviceId: string): Promise<{ token: string }> {
  if (!uuid.safeParse(deviceId).success) throw new AppError('VALIDATION_ERROR', 'Некоректний ідентифікатор каси', 422)
  const token = randomBytes(32).toString('base64url')
  const { rowCount } = await pool.query(
    `INSERT INTO till_devices (tenant_id, device_id, token_hash, created_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (device_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_by = EXCLUDED.created_by, created_at = now()
       WHERE till_devices.tenant_id = EXCLUDED.tenant_id`,
    [tenantId, deviceId, hash(token), userId],
  )
  // Пристрій уже записаний за іншим магазином — чужий ключ не перезаписуємо.
  if (!rowCount) throw new AppError('FORBIDDEN', 'Цей пристрій зареєстровано в іншому магазині', 403)
  return { token }
}

/** `Authorization: Device <device_id>.<ключ>` */
export function parseDeviceAuthorization(header: string | undefined): { deviceId: string; token: string } | null {
  const match = /^Device ([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,200})$/i.exec(String(header ?? ''))
  return match && uuid.safeParse(match[1]).success ? { deviceId: match[1].toLowerCase(), token: match[2] } : null
}

/** Хто цей пристрій. Невідомий пристрій чи невірний ключ — null. */
export async function authenticateTillDevice(deviceId: string, token: string): Promise<{ tenant_id: string; device_id: string } | null> {
  const { rows } = await pool.query('SELECT tenant_id, token_hash FROM till_devices WHERE device_id = $1', [deviceId])
  const row = rows[0]
  if (!row) return null
  const given = Buffer.from(hash(token), 'hex'), stored = Buffer.from(String(row.token_hash), 'hex')
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) return null
  return { tenant_id: row.tenant_id as string, device_id: deviceId }
}
