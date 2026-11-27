import type { LocalDatabase } from '../../db/localDatabase'
import { subtractStockQuantity } from '../stockQuantity'

/**
 * Бронь товару під замовлення (27.11.2026, завдання власника: «оплачені замовлення із сайту бронюють товар; каса не дає
 * продати заброньоване»).
 *
 * Вільний залишок = залишок на складі − кількість у відкритих (не виданих і не скасованих) замовленнях (stock_reserves).
 * Продати більше вільного не можна, навіть коли власник увімкнув «Продаж при відсутності товару»: продаж у мінус —
 * це про товар, якого просто немає, а не про той, що вже обіцяний покупцеві (за сайт уже заплатили).
 * Коли бронь нічого не зачіпає (на складі 0, броні немає) — продаж у мінус працює, як і раніше.
 */
export const SITE_PAID_MARK = 'ОПЛАЧЕНО НА САЙТІ'
/** Мітка в тексті помилки, за якою каса показує кнопку «Відкрити замовлення». */
export const RESERVED_ORDER_TAG = /\[order:([0-9a-f-]{36})\]/i

export interface ReserveHolder { order_id: string; order_number: string; site: boolean; paid_on_site: boolean; qty: number }

/** Хто тримає бронь цього товару (без замовлення, яке зараз видають). */
export function reserveHolders(db: LocalDatabase, tenantId: string, productId: string, exceptOrderId?: string | null): ReserveHolder[] {
  const rows = db.prepare(`
    SELECT r.order_id, COALESCE(o.order_number, '') AS order_number, COALESCE(o.source, '') AS source, COALESCE(o.comment, '') AS comment,
           SUM(r.qty) AS qty, MIN(o.created_at) AS created_at
    FROM stock_reserves r
    LEFT JOIN customer_orders o ON o.id = r.order_id AND o.tenant_id = r.tenant_id
    WHERE r.tenant_id = ? AND r.product_id = ? AND r.released_at IS NULL AND r.deleted_at IS NULL
      AND (r.expires_at IS NULL OR unixepoch(r.expires_at) > unixepoch('now'))
      AND (? IS NULL OR r.order_id IS NULL OR r.order_id <> ?)
    GROUP BY r.order_id
    ORDER BY created_at`).all(tenantId, productId, exceptOrderId ?? null, exceptOrderId ?? null) as Array<{ order_id: string | null; order_number: string; source: string; comment: string; qty: number }>
  return rows.map(row => ({ order_id: String(row.order_id ?? ''), order_number: row.order_number, site: row.source === 'site',
    paid_on_site: row.source === 'site' && row.comment.includes(SITE_PAID_MARK), qty: Number(row.qty) || 0 }))
}

const describe = (holder: ReserveHolder) => `№${holder.order_number || '?'}${holder.paid_on_site ? ' (сайт, оплачено)' : holder.site ? ' (сайт)' : ''}`

/**
 * Перевірка одного товару. Повертає null (можна продавати) або помилку з поясненням, у якому замовленні товар.
 * allowNegative — увімкнено «Продаж при відсутності товару».
 */
export function reservedStockProblem(input: { name: string; qtyOnHand: number; requested: number; allowNegative: boolean; holders: ReserveHolder[] }): Error | null {
  const reserved = input.holders.reduce((sum, holder) => sum + holder.qty, 0)
  const free = subtractStockQuantity(input.qtyOnHand, reserved)
  if (input.requested <= free) return null
  if (reserved <= 0) {
    if (input.allowNegative) return null
    return new Error(`Недостатньо товару «${input.name}». Доступно: ${free}, потрібно: ${input.requested}. Щоб продавати в мінус, увімкніть «Продаж при відсутності товару» в Налаштуваннях.`)
  }
  const first = input.holders.find(holder => holder.qty > 0)
  const list = input.holders.filter(holder => holder.qty > 0).map(describe).join(', ')
  const tag = first?.order_id ? ` [order:${first.order_id}]` : ''
  return new Error(`Недостатньо товару «${input.name}»: товар у замовленні ${list}. Доступно: ${Math.max(free, 0)}, потрібно: ${input.requested}. Продати заброньоване не можна — спершу видайте або скасуйте замовлення.${tag}`)
}
