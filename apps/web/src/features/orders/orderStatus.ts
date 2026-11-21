import type { CustomerOrderStatus } from './orderApi'

const TERMINAL_ORDER_STATUSES = new Set<CustomerOrderStatus>(['completed', 'canceled', 'archived'])
const COMPLETED_ORDER_STATUSES = new Set<CustomerOrderStatus>(['completed', 'archived'])
const DELETABLE_ORDER_STATUSES = new Set<CustomerOrderStatus>(['lead', 'quoted', 'new'])

export function isTerminalOrderStatus(status: string): boolean {
  return TERMINAL_ORDER_STATUSES.has(status as CustomerOrderStatus)
}

export function isCompletedOrderStatus(status: string): boolean {
  return COMPLETED_ORDER_STATUSES.has(status as CustomerOrderStatus)
}

export function canDeleteDraftOrder(order: {
  status: string
  prepayment?: number | null
  total_paid?: number | null
  sale_id?: string | null
  from_notebook?: boolean
  items?: Array<{ item_status?: string | null }>
}): boolean {
  // Помилкове перенесення з блокнота можна прибрати, поки по замовленню не було грошей і видачі.
  const notebook = order.from_notebook === true
    && (order.items ?? []).every(item => item.item_status !== 'handed' && item.item_status !== 'returned')
  return (DELETABLE_ORDER_STATUSES.has(order.status as CustomerOrderStatus) || notebook)
    && Number(order.prepayment ?? 0) === 0
    && Number(order.total_paid ?? 0) === 0
    && !order.sale_id
}
