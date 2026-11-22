import { z } from 'zod'
import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { PENDING_COMMAND_TTL_SQL, TILL_ONLINE_SECONDS } from './tillCommandService.js'
import { wakeTill, type TillWake } from './tillWake.js'

/**
 * Зв'язок головного ПК із сервером (22.11.2026, «каса головна»; сервер — лише передавач).
 *
 * Досі каса питала сервер двома окремими опитуваннями — кожні 3 с і кожні 5 с, тобто 1 920 разів
 * на годину, навіть коли у вебі нікого немає. Тепер одне легке «чи є для мене робота»:
 *  - у вебі нікого немає — раз на 30 с (120 на годину);
 *  - хтось відкрив веб або надіслав запит — каса отримує сигнал одразу й питає кожні 3 с,
 *    доки у вебі працюють.
 * Зв'язок — звичайні запити каси назовні; на власному сервері зміниться лише адреса й транспорт сигналу.
 */

/** Запит вебу, не забраний касою за цей час, не виконується ніколи. Довший за рідке опитування каси. */
export const RPC_CLAIM_SECONDS = 45
/** Скільки після останнього звернення вебу вважаємо, що у вебі хтось працює. */
export const WEB_ACTIVE_SECONDS = 90
/** Сигнал касі шлемо, лише коли веб з'явився після паузи, довшої за це (веб питає стан кожні 20 с). */
const WEB_RETURN_SECONDS = 30
/** Як часто касі питати: коли у вебі працюють і коли нікого немає. */
export const BEAT_FAST_MS = 3_000
export const BEAT_SLOW_MS = 30_000

/** Каса: «я на зв'язку» + чи є для мене робота. Один запит до бази замість п'яти-шести. */
export async function tillBeat(tenantId: string, deviceId: string) {
  if (!z.string().uuid().safeParse(deviceId).success) throw new AppError('VALIDATION_ERROR', 'Некоректний ідентифікатор каси', 422)
  const { rows } = await pool.query(
    `WITH presence AS (
       INSERT INTO till_presence (tenant_id, device_id, seen_at) VALUES ($1, $2, now())
       ON CONFLICT (tenant_id) DO UPDATE SET device_id = EXCLUDED.device_id, seen_at = now()
       RETURNING web_seen_at
     )
     SELECT COALESCE((SELECT web_seen_at > now() - make_interval(secs => $3) FROM presence), false) AS web_active,
            EXISTS (SELECT 1 FROM till_rpc WHERE tenant_id = $1 AND status = 'pending'
                      AND created_at > now() - make_interval(secs => $4)) AS rpc,
            EXISTS (SELECT 1 FROM till_commands WHERE tenant_id = $1 AND status = 'pending'
                      AND created_at > now() - ${PENDING_COMMAND_TTL_SQL}) AS commands`,
    [tenantId, deviceId, WEB_ACTIVE_SECONDS, RPC_CLAIM_SECONDS],
  )
  const row = rows[0] ?? {}
  const webActive = Boolean(row.web_active)
  return { rpc: Boolean(row.rpc), commands: Boolean(row.commands), web_active: webActive, next_ms: webActive ? BEAT_FAST_MS : BEAT_SLOW_MS }
}

/**
 * Веб показав сторінку, що працює через головний ПК, або надіслав запит: позначаємо «у вебі працюють».
 * Каса дізнається про це із сигналу (одразу) або зі свого рідкого опитування. Сигнал — лише коли веб
 * з'явився після паузи: відкрита сторінка питає стан кожні 20 с, будити касу щоразу не потрібно.
 */
export async function touchWebPresence(tenantId: string, wake: TillWake = wakeTill) {
  const { rows } = await pool.query(
    `WITH before AS (SELECT seen_at, web_seen_at FROM till_presence WHERE tenant_id = $1),
          touched AS (UPDATE till_presence SET web_seen_at = now() WHERE tenant_id = $1 RETURNING 1)
     SELECT seen_at, seen_at > now() - make_interval(secs => $2) AS online,
            COALESCE(web_seen_at > now() - make_interval(secs => $3), false) AS was_active
       FROM before`,
    [tenantId, TILL_ONLINE_SECONDS, WEB_RETURN_SECONDS],
  )
  const row = rows[0]
  const online = Boolean(row?.online)
  if (online && !row.was_active) await wake(tenantId)
  return { online, seen_at: row ? new Date(row.seen_at).toISOString() : null }
}
