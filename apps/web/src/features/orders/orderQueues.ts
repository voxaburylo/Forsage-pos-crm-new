import { isReadyOrderStatus } from './orderUx'

export interface QueueOrder {
  status: string
  source?: string | null
  items?: Array<{ is_draft_note?: boolean }>
}

// Shared with the order list: a walk-in lead is an open order, not a handwritten draft.
export function isDraftOrder(order: QueueOrder): boolean {
  return order.status === 'quoted' || (order.status === 'lead'
    && (order.source === 'mobile_draft' || Boolean(order.items?.some(item => item.is_draft_note))))
}
export function isLeadOrder(order: QueueOrder): boolean {
  return order.status === 'lead' && !isDraftOrder(order)
}
export function orderActionCounts(orders: QueueOrder[]) {
  return {
    drafts: orders.filter(isDraftOrder).length,
    leads: orders.filter(isLeadOrder).length,
    ready: orders.filter(order => isReadyOrderStatus(order.status)).length,
  }
}

export const ACTION_ROUTES = {
  ready: '/orders?tab=ready&search=', drafts: '/orders?tab=drafts&search=', leads: '/orders?tab=leads&search=',
  debts: '/customers?has_debt=true', waitlist: '/waitlist',
} as const

// Bounded, fresh reads only. Never present a truncated/failed read as an exact zero.
export async function readActionPages<T extends { id: string }>(
  read: (page: number, offset: number) => Promise<{ data: T[]; hasMore: boolean }>,
  isCurrent: () => boolean,
): Promise<T[] | null> {
  const rows = new Map<string, T>()
  let offset = 0
  for (let page = 1; page <= 50; page++) {
    if (!isCurrent()) return null
    const result = await read(page, offset)
    if (!isCurrent()) return null
    const previousSize = rows.size
    for (const row of result.data) rows.set(row.id, row)
    if (!result.hasMore) return [...rows.values()]
    if (rows.size === previousSize) throw new Error('Не вдалося прочитати повну вибірку. Повторіть завантаження.')
    offset += result.data.length
  }
  throw new Error('Вибірка завелика для точного підсумку. Відкрийте відповідний список.')
}
