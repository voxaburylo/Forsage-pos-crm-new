import type { CustomerOrderStatus, ItemStatus } from './orderApi'

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
