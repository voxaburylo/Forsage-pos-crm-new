import { pool } from '../db/pg.js'
import { logger } from '../lib/logger.js'
import { sendOwnerTelegram } from './ownerAlertService.js'
import { kopecks, siteOrderRow, tillOrderPayload, type PullDeps } from './siteOrderPull.js'
import { wakeTill } from './tillWake.js'

/**
 * Оплачені замовлення сайту самі стають замовленнями програми (27.11.2026, завдання власника: «сайт починає приймати
 * онлайн-оплату (LiqPay); оплачені замовлення автоматично стають замовленнями в програмі й бронюють товар»).
 *
 * Що використовуємо із site-api (контракт сайту, нічого в базі сайту напряму):
 *  - `orders.list { paid: true, synced: false }` — оплачені замовлення, ще не перенесені в програму
 *    (поля замовлення `paid`, `paid_at`, `paid_amount`, `program_order_id`);
 *  - `orders.mark_synced { id, program_order_id, program_order_number }` — позначка «перенесено», щоб не створити двічі.
 *
 * Хід (раз на хвилину, разом із забиранням звичайних замовлень сайту; працює на сервері, навіть коли програма закрита):
 *  1. Каса вже створила замовлення за командою — запамʼятати його номер (site_orders.program_order_id).
 *  2. Для кожного оплаченого й не перенесеного: є номер програми → `orders.mark_synced`; немає → команда касі
 *     `order.save` (номер операції = рядок site_orders: дубль неможливий навіть при повторах).
 *  3. Каса створює звичайне замовлення з джерелом «сайт» і позначкою «ОПЛАЧЕНО НА САЙТІ»; товар бронюється (як у будь-
 *     якого замовлення зі складу). Товару не вистачає — замовлення все одно створюється з позначкою «КОНФЛІКТ» і власнику
 *     йде повідомлення в Telegram (гроші вже сплачено: вирішити — повернути чи привезти).
 */
export interface PaidInfo { amount: number; paid_at: string | null }

export function sitePaidInfo(raw: unknown): PaidInfo | null {
  const order = (raw ?? {}) as Record<string, unknown>
  if (order.paid !== true) return null
  const paidAt = typeof order.paid_at === 'string' && !Number.isNaN(Date.parse(order.paid_at)) ? new Date(order.paid_at).toISOString() : null
  return { amount: kopecks(order.paid_amount ?? order.total), paid_at: paidAt }
}

/** Бланк для каси: звичайне замовлення сайту + що й коли сплачено онлайн. */
export function paidTillOrderPayload(raw: unknown) {
  const row = siteOrderRow(raw)
  const paid = sitePaidInfo(raw)
  if (!row || !paid) return null
  return { row, payload: { ...tillOrderPayload(row), paid } }
}

const listOf = (answer: unknown): unknown[] => Array.isArray(answer) ? answer : Array.isArray((answer as { orders?: unknown })?.orders) ? (answer as { orders: unknown[] }).orders : []

export async function pullPaidSiteOrders(tenantId: string, startedBy: string, deps: PullDeps = {}): Promise<{ seen: number; queued: number; synced: number; conflicts: number }> {
  const gateway = deps.gateway ?? (async (action: string, params: Record<string, unknown>) => (await import('./siteGatewayService.js')).callSiteGateway(action, params))
  // 1. Відповіді каси → номер замовлення програми в site_orders (і чи був конфлікт).
  await pool.query(
    `UPDATE site_orders o SET program_order_id = (c.result->>'order_id')::uuid, program_order_number = c.result->>'order_number', updated_at = now()
       FROM till_commands c
      WHERE o.tenant_id = $1 AND o.program_order_id IS NULL AND c.tenant_id = o.tenant_id AND c.operation_id = o.id AND c.command = 'order.save' AND c.status = 'done'
        AND c.result->>'order_id' ~* '^[0-9a-f-]{36}$'`, [tenantId])
  const conflicts = await alertConflicts(tenantId)

  const list = listOf(await gateway('orders.list', { paid: true, synced: false, limit: 50, offset: 0 }))
  let queued = 0, synced = 0
  for (const raw of list) {
    const prepared = paidTillOrderPayload(raw)
    if (!prepared) continue
    const { row, payload } = prepared
    await pool.query(
      `INSERT INTO site_orders (tenant_id, external_id, customer_name, customer_phone, delivery, comment, items, total_amount, site_status, canceled, site_created_at, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb) ON CONFLICT (tenant_id, external_id) DO UPDATE SET raw = EXCLUDED.raw, updated_at = now()`,
      [tenantId, row.external_id, row.customer_name, row.customer_phone, row.delivery, row.comment, JSON.stringify(row.items), row.total_amount, row.site_status, row.canceled, row.site_created_at, JSON.stringify(raw)])
    const saved = (await pool.query('SELECT id::text AS id, program_order_id::text AS program_order_id, program_order_number FROM site_orders WHERE tenant_id = $1 AND external_id = $2', [tenantId, row.external_id])).rows[0] as { id: string; program_order_id: string | null; program_order_number: string | null } | undefined
    if (!saved) continue
    if (saved.program_order_id) {
      try {
        await gateway('orders.mark_synced', { id: row.external_id, program_order_id: saved.program_order_id, program_order_number: saved.program_order_number ?? '' })
        synced += 1
      } catch (error) { logger.warn({ code: (error as { code?: string })?.code }, '[site-paid] mark_synced failed') }
      continue
    }
    // Скасоване на сайті після оплати — це повернення грошей на сайті; бронювати нема чого. Каса збереже його скасованим.
    // Каса була вимкнена довше за строк черги (7 днів) — команду, яку так і не виконали, ставимо знову.
    const { rowCount } = await pool.query(
      `INSERT INTO till_commands (tenant_id, operation_id, command, payload, requested_by) VALUES ($1, $2::uuid, 'order.save', $3::jsonb, $4)
       ON CONFLICT (tenant_id, operation_id) DO UPDATE SET status = 'pending', payload = EXCLUDED.payload, created_at = now(), claimed_at = NULL, finished_at = NULL, device_id = NULL
       WHERE till_commands.status = 'expired'`, [tenantId, saved.id, JSON.stringify(payload), startedBy])
    if (rowCount) queued += 1
  }
  if (queued) await (deps.wake ?? wakeTill)(tenantId).catch(() => undefined)
  return { seen: list.length, queued, synced, conflicts }
}

/** Каса створила оплачене замовлення, але товару не вистачило, — одне повідомлення власнику на замовлення. */
async function alertConflicts(tenantId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT o.external_id, o.program_order_number, c.result->>'conflict_note' AS note, s.owner_telegram_chat_id AS chat
       FROM site_orders o JOIN till_commands c ON c.tenant_id = o.tenant_id AND c.operation_id = o.id AND c.command = 'order.save' AND c.status = 'done'
       LEFT JOIN shop_settings s ON s.tenant_id = o.tenant_id
      WHERE o.tenant_id = $1 AND c.result->>'conflict' = 'true' AND c.finished_at > now() - interval '2 days'
      LIMIT 20`, [tenantId])
  let sent = 0
  for (const row of rows as Array<{ external_id: string; program_order_number: string | null; note: string | null; chat: string | null }>) {
    const { rowCount } = await pool.query('INSERT INTO owner_alert_log (tenant_id, alert_key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tenantId, 'site_paid_conflict:' + row.external_id])
    if (!rowCount || !row.chat) continue
    const text = `⚠️ Оплачене замовлення із сайту № ${row.external_id} (у програмі № ${row.program_order_number ?? '?'}): товару не вистачає.\n${row.note ?? ''}\nГроші вже сплачено — вирішіть: повернути чи привезти товар.`
    if (await sendOwnerTelegram(Number(row.chat), text)) sent += 1
    else await pool.query('DELETE FROM owner_alert_log WHERE tenant_id = $1 AND alert_key = $2', [tenantId, 'site_paid_conflict:' + row.external_id])
  }
  return sent
}
