import type { CreateOrderPayload, CustomerOrder } from '@/features/orders/orderApi'
import { checkTillOrder, tillOrderToCreate, type TillOrderCard, type TillOrderItem } from './tillOrderModel'

/**
 * Дозамовлення з вебу (телефон) — етап 8 плану замовлень, 22.11.2026.
 * З вебу до наявного відкритого замовлення можна лише ДОДАТИ позиції та примітку. Наявні позиції, їхні стани,
 * клієнт, авто, гроші й видача не змінюються — це робить людина на касі. Додає каса у своїй базі.
 */
export interface TillOrderAppendPayload {
  order_id: string
  /** Хто додав у вебі — лише для примітки. */
  author?: string | null
  comment?: string | null
  items: TillOrderItem[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CLOSED = new Set(['completed', 'canceled', 'archived'])
/** Стани позицій, які каса дозволяє зберігати редагуванням; видане й повернене — лише через касу. */
const EDITABLE_ITEM = new Set(['pending', 'ordered', 'arrived', 'canceled'])
const clean = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max)
/** Перевірки позицій ті самі, що й у нового бланка; клієнт тут не потрібен — він уже є в замовленні. */
const asOrder = (items: unknown) => ({ customer_name: 'дозамовлення', items: items as TillOrderItem[] })

/** Перевірка дозамовлення — однакова у вебі перед відправкою і на касі перед записом. */
export function checkTillOrderAppend(raw: unknown): TillOrderAppendPayload {
  const input = (raw ?? {}) as Partial<TillOrderAppendPayload>
  const orderId = clean(input.order_id, 36)
  if (!UUID.test(orderId)) throw new Error('Не вказано замовлення. Відкрийте його зі списку ще раз.')
  return { order_id: orderId, author: clean(input.author, 120) || null, comment: clean(input.comment, 500) || null,
    items: checkTillOrder(asOrder(input.items)).items }
}

/**
 * Дозамовлення → звичайне редагування замовлення на касі: усі наявні позиції лишаються як є, нові додаються в кінець.
 * Версію замовлення бере каса зі своєї бази в ту саму мить, тож чужі правки не перезаписуються.
 */
export function tillOrderAppendToUpdate(payload: TillOrderAppendPayload, current: CustomerOrder | null, operationId: string,
  cards: ReadonlyMap<string, TillOrderCard | null> = new Map()): CreateOrderPayload {
  const append = checkTillOrderAppend(payload)
  if (!current || current.id !== append.order_id) throw new Error('Цього замовлення немає в базі каси. Оновіть список і спробуйте ще раз.')
  if (CLOSED.has(current.status) || current.sale_id) throw new Error('Замовлення вже закрите (видане, скасоване або в архіві). Оформіть нове замовлення.')
  const kept = (current.items ?? []).filter(item => !item.is_draft_note)
  if (kept.some(item => !EDITABLE_ITEM.has(item.item_status))) throw new Error('У замовленні вже є видані або повернені позиції. Додати до нього можна лише на касі.')
  // Ті самі правила, що й для нового бланка: картка зі складу — з бази каси, ціна не нижча за закупку.
  const added = tillOrderToCreate(asOrder(append.items), null, operationId, cards).items
  const note = `Дозамовлено у вебі${append.author ? ` (${append.author})` : ''}: позицій ${added.length}${append.comment ? `. ${append.comment}` : ''}`
  return {
    operation_id: operationId,
    expected_updated_at: current.updated_at,
    comment: [current.comment ?? '', note].filter(Boolean).join('\n').slice(0, 4000),
    // Наявні рядки передаємо цілком (стан, застава за оборотну деталь тощо), щоб редагування нічого в них не змінило.
    items: [...kept.map(item => ({ ...item })), ...added],
  }
}
