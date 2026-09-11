import type { CustomerOrderStatus, ItemStatus } from './orderApi'

/** No agreed price yet; a paid/discounted priced order is not an open deposit. */
export function isUnpricedOrder(order: { status: string; total_amount: number; items: Array<{ item_status: string; sell_price: number; core_deposit_amount?: number }> }): boolean {
  if (!['lead', 'quoted', 'new'].includes(order.status) || Number(order.total_amount) !== 0) return false
  const active = order.items.filter((item) => !['canceled', 'returned'].includes(item.item_status))
  return (order.items.length === 0 || active.length > 0)
    && active.every((item) => Number(item.sell_price) === 0 && Number(item.core_deposit_amount ?? 0) === 0)
}

const TRANSITIONS: Partial<Record<CustomerOrderStatus, CustomerOrderStatus[]>> = {
  lead: ['new', 'in_progress', 'ordered'],
  quoted: ['new', 'in_progress', 'ordered'],
  new: ['in_progress', 'ordered'],
  in_progress: ['new', 'ordered'],
  ordered: ['new'],
  arrived: ['called', 'no_answer'],
  ready: ['called', 'no_answer'],
  called: ['no_answer', 'ready'],
  no_answer: ['called', 'ready'],
}

export function allowedOrderStatusTransitions(status: CustomerOrderStatus): CustomerOrderStatus[] {
  return TRANSITIONS[status] ?? []
}

export function canManuallyChangeOrderStatus(from: CustomerOrderStatus, to: CustomerOrderStatus): boolean {
  return from === to || allowedOrderStatusTransitions(from).includes(to)
}

export function canIssueOrderFromPos(order: { status: string; items?: Array<{ item_status: ItemStatus | string }> }): boolean {
  if (!['ready', 'called', 'no_answer'].includes(order.status)) return false
  const active = (order.items ?? []).filter((item) => !['canceled', 'returned'].includes(item.item_status))
  return active.length > 0 && active.every((item) => ['arrived', 'handed'].includes(item.item_status))
}
