import type { CustomerOrder, CustomerOrderStatus, ItemStatus } from './orderApi'

/** Перегляд замовлень у вебі: лише читання копії з каси. */
export const ORDER_STATUS_LABEL: Record<CustomerOrderStatus, string> = {
  lead: 'Лід', quoted: 'Чернетка', new: 'Нове', in_progress: 'В роботі', ordered: 'Замовлено',
  arrived: 'Прибуло', called: 'Повідомлено', no_answer: 'Не відповів', ready: 'До видачі',
  completed: 'Видано', canceled: 'Скасовано', archived: 'Архів',
}

export const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  pending: 'Очікує', ordered: 'Замовлено', arrived: 'Прибуло', handed: 'Видано', canceled: 'Скасовано', returned: 'Повернено',
}

export type OrderViewGroup = 'active' | 'ready' | 'done' | 'all'
export const ORDER_VIEW_GROUPS: Array<{ id: OrderViewGroup; label: string }> = [
  { id: 'active', label: 'В роботі' },
  { id: 'ready', label: 'Готові до видачі' },
  { id: 'done', label: 'Видані й скасовані' },
  { id: 'all', label: 'Усі' },
]

const READY: CustomerOrderStatus[] = ['arrived', 'called', 'no_answer', 'ready']
const DONE: CustomerOrderStatus[] = ['completed', 'canceled', 'archived']

export function orderGroup(status: CustomerOrderStatus): Exclude<OrderViewGroup, 'all'> {
  if (READY.includes(status)) return 'ready'
  if (DONE.includes(status)) return 'done'
  return 'active'
}

/** Борг клієнта за замовленням у копійках (не менше нуля). Скасоване не винне нічого. */
export function orderDebt(order: Pick<CustomerOrder, 'total_amount' | 'total_paid' | 'status'>): number {
  if (order.status === 'canceled') return 0
  return Math.max(0, Number(order.total_amount || 0) - Number(order.total_paid || 0))
}

export type PaymentState = 'paid' | 'partial' | 'unpaid'
export function orderPaymentState(order: Pick<CustomerOrder, 'total_amount' | 'total_paid' | 'status'>): PaymentState {
  if (orderDebt(order) === 0) return 'paid'
  return Number(order.total_paid || 0) > 0 ? 'partial' : 'unpaid'
}

/** Минув строк видачі, а замовлення ще не видане. */
export function pickupOverdue(order: Pick<CustomerOrder, 'pickup_deadline_at' | 'status'>, now = Date.now()): boolean {
  if (!order.pickup_deadline_at || orderGroup(order.status) === 'done') return false
  const deadline = Date.parse(order.pickup_deadline_at)
  return Number.isFinite(deadline) && deadline < now
}

export function filterOrders(orders: readonly CustomerOrder[], group: OrderViewGroup): CustomerOrder[] {
  return group === 'all' ? [...orders] : orders.filter(order => orderGroup(order.status) === group)
}
