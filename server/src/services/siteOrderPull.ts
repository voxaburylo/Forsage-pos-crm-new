import { pool } from '../db/pg.js'
import { logger } from '../lib/logger.js'
import { AppError } from '../middleware/errorHandler.js'
import { callSiteGateway } from './siteGatewayService.js'
import { SITE_ORDER_AUTHOR } from './tillCommandService.js'
import { wakeTill } from './tillWake.js'

/**
 * Замовлення із сайту зберігаються в програмі (27.11.2026). Раз на хвилину сервер питає сайт (шлюз, дія orders.list),
 * нове замовлення пише в site_orders (external_id = номер замовлення на сайті) і ставить касі команду створити звичайне
 * замовлення з джерелом 'site'. Замовлення — дані каси, тому в customer_orders його створює КАСА, а в хмару воно
 * приходить звичайним обміном; сервер у customer_orders сам не пише.
 * Скасоване на сайті теж зберігається — з позначкою «скасовано». Те саме замовлення двічі не записується:
 * номер сайту унікальний у site_orders, а команда касі має номер операції = рядок site_orders.
 */
export interface SiteOrderItem { product_id: string | null; name: string; sku: string | null; qty: number; price: number }
export interface SiteOrderRow {
  external_id: string; customer_name: string; customer_phone: string; delivery: string | null; comment: string | null
  items: SiteOrderItem[]; total_amount: number; site_status: string; canceled: boolean; site_created_at: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (value: unknown, max: number) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
/** Гроші сайту — гривні з копійками (1155.00); у програмі — копійки. */
export const kopecks = (value: unknown) => { const amount = Math.round(Number(value) * 100); return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0 }
export const isCanceled = (status: unknown) => /^cancel/i.test(String(status ?? '').trim())

/** Рядок із відповіді сайту → рядок для site_orders. null — у відповіді немає номера замовлення. */
export function siteOrderRow(raw: unknown): SiteOrderRow | null {
  const order = (raw ?? {}) as Record<string, unknown>
  const id = text(order.id, 64)
  if (!id || !/^[A-Za-z0-9._:-]{1,64}$/.test(id)) return null
  const digits = String(order.customer_phone ?? '').replace(/\D/g, '')
  const items = (Array.isArray(order.items) ? order.items : []).slice(0, 60).map(entry => {
    const item = (entry ?? {}) as Record<string, unknown>
    const qty = Number(item.qty)
    const product = text(item.program_product_id, 36)
    return { product_id: UUID.test(product) ? product : null, name: text(item.title ?? item.name, 300) || 'Товар із сайту', sku: text(item.sku, 100) || null,
      qty: Number.isFinite(qty) && qty > 0 ? Math.round(qty * 1000) / 1000 : 1, price: kopecks(item.price) }
  })
  const delivery = [text(order.delivery_method, 80), text(order.city, 80), text(order.warehouse, 120)].filter(Boolean).join(', ').slice(0, 300)
  const created = typeof order.created_at === 'string' && !Number.isNaN(Date.parse(order.created_at)) ? new Date(order.created_at).toISOString() : null
  const status = text(order.status, 40) || 'new'
  return {
    external_id: id, customer_name: text(order.customer_name, 120) || 'Покупець сайту', customer_phone: digits.length >= 10 && digits.length <= 12 ? digits : '',
    delivery: delivery || null, comment: text(order.comment, 500) || null, items,
    total_amount: kopecks(order.total) || items.reduce((sum, item) => sum + Math.round(item.price * item.qty), 0),
    site_status: status, canceled: isCanceled(status), site_created_at: created,
  }
}

/** Бланк для каси: звичайне замовлення з джерелом «сайт». Позиція без нашої картки (шини сайту) іде текстом. */
export function tillOrderPayload(row: SiteOrderRow) {
  const note = [`Замовлення із сайту № ${row.external_id}`, row.canceled ? 'СКАСОВАНО на сайті' : '', row.delivery ? 'Доставка: ' + row.delivery : '', row.comment ?? ''].filter(Boolean).join('. ').slice(0, 1000)
  return {
    customer_phone: row.customer_phone || null, customer_name: row.customer_name, comment: note, author: SITE_ORDER_AUTHOR, source: 'site', canceled: row.canceled,
    items: row.items.map(item => ({ name: item.name, sku: item.sku, qty: item.qty, sell_price: item.price, ...(item.product_id ? { product_id: item.product_id } : {}) })),
  }
}

/** Магазин, що користується розділом «Сайт»: рядок зʼявляється, коли власник відкриває розділ (раз на процес — без зайвих записів). */
const remembered = new Set<string>()
export async function rememberSiteTenant(user: { id: string; tenant_id: string }): Promise<void> {
  if (remembered.has(user.tenant_id)) return
  await pool.query(`INSERT INTO site_order_sync (tenant_id, started_by) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING`, [user.tenant_id, user.id])
  remembered.add(user.tenant_id)
}

export interface PullDeps { gateway?: (action: string, params: Record<string, unknown>) => Promise<unknown>; wake?: (tenantId: string) => Promise<unknown> }

/** Один магазин: забрати останні замовлення сайту, нові — зберегти й передати касі, у відомих — оновити статус. */
export async function pullSiteOrders(tenantId: string, startedBy: string, deps: PullDeps = {}): Promise<{ seen: number; saved: number; canceled: number }> {
  const gateway = deps.gateway ?? ((action, params) => callSiteGateway(action, params))
  const answer = await gateway('orders.list', { limit: 50, offset: 0 })
  const list = Array.isArray(answer) ? answer : Array.isArray((answer as { orders?: unknown })?.orders) ? (answer as { orders: unknown[] }).orders : []
  let saved = 0, canceled = 0
  for (const raw of list) {
    const row = siteOrderRow(raw)
    if (!row) continue
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query(
        `INSERT INTO site_orders (tenant_id, external_id, customer_name, customer_phone, delivery, comment, items, total_amount, site_status, canceled, site_created_at, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb) ON CONFLICT (tenant_id, external_id) DO NOTHING RETURNING id`,
        [tenantId, row.external_id, row.customer_name, row.customer_phone, row.delivery, row.comment, JSON.stringify(row.items), row.total_amount, row.site_status, row.canceled, row.site_created_at, JSON.stringify(raw)])
      if (inserted.rows[0]) {
        saved += 1
        if (row.canceled) canceled += 1
        // Замовлення без жодної позиції каса не прийме — воно лишається в site_orders, видно у вкладці «Замовлення».
        if (row.items.length) await client.query(
          `INSERT INTO till_commands (tenant_id, operation_id, command, payload, requested_by) VALUES ($1, $2, 'order.save', $3::jsonb, $4)`,
          [tenantId, inserted.rows[0].id, JSON.stringify(tillOrderPayload(row)), startedBy])
      } else {
        // Відоме замовлення: оновити статус; щойно скасоване на сайті — позначити й сказати касі.
        const known = await client.query('SELECT id, canceled, site_status FROM site_orders WHERE tenant_id = $1 AND external_id = $2 FOR UPDATE', [tenantId, row.external_id])
        const before = known.rows[0] as { id: string; canceled: boolean; site_status: string | null } | undefined
        if (before && (before.site_status !== row.site_status || before.canceled !== row.canceled))
          await client.query('UPDATE site_orders SET site_status = $3, canceled = $4, updated_at = now() WHERE tenant_id = $1 AND external_id = $2', [tenantId, row.external_id, row.site_status, row.canceled || before.canceled])
        if (before && row.canceled && !before.canceled) {
          canceled += 1
          await client.query(
            `INSERT INTO till_commands (tenant_id, operation_id, command, payload, requested_by)
             SELECT $1, gen_random_uuid(), 'order.site_cancel', jsonb_build_object('site_order_id', $2::text, 'external_id', $3::text, 'order_id', c.result->>'order_id'), $4
               FROM till_commands c WHERE c.tenant_id = $1 AND c.operation_id = $2 AND c.command = 'order.save' AND c.status = 'done' AND c.result->>'order_id' IS NOT NULL`,
            [tenantId, before.id, row.external_id, startedBy])
          // Каса ще не встигла створити замовлення — нехай створить уже з позначкою «скасовано».
          await client.query(
            `UPDATE till_commands SET payload = payload || '{"canceled": true}'::jsonb WHERE tenant_id = $1 AND operation_id = $2 AND command = 'order.save' AND status = 'pending'`,
            [tenantId, before.id])
        }
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally { client.release() }
  }
  if (saved || canceled) await (deps.wake ?? wakeTill)(tenantId).catch(() => undefined)
  return { seen: list.length, saved, canceled }
}

/** Пробудження від планувальника (щохвилини, разом із фоновими задачами). Помилка одного магазину не заважає іншим. */
export async function runSiteOrderPullStep(deps: PullDeps = {}): Promise<{ shops: number; saved: number; canceled: number; errors: number }> {
  const { rows } = await pool.query('SELECT tenant_id::text AS tenant_id, started_by::text AS started_by FROM site_order_sync WHERE enabled LIMIT 5')
  let saved = 0, canceled = 0, errors = 0
  for (const shop of rows as Array<{ tenant_id: string; started_by: string }>) {
    try {
      const result = await pullSiteOrders(shop.tenant_id, shop.started_by, deps)
      saved += result.saved; canceled += result.canceled
      await pool.query('UPDATE site_order_sync SET last_run_at = now(), last_error = NULL, updated_at = now() WHERE tenant_id = $1', [shop.tenant_id])
    } catch (error) {
      errors += 1
      logger.warn({ code: (error as AppError)?.code }, '[site-orders] pull failed')
      await pool.query('UPDATE site_order_sync SET last_run_at = now(), last_error = $2, updated_at = now() WHERE tenant_id = $1',
        [shop.tenant_id, error instanceof AppError ? error.message : 'Не вдалося забрати замовлення із сайту; повтор за хвилину.']).catch(() => undefined)
    }
  }
  return { shops: rows.length, saved, canceled, errors }
}
