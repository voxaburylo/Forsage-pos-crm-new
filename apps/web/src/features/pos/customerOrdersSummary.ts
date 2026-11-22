export interface CustomerOrderMoney {
  status: string
  total_amount: number
  discount_amount?: number | null
  prepayment: number
  total_paid: number
}

const CLOSED = new Set(['completed', 'canceled', 'archived'])
const READY = new Set(['arrived', 'called', 'no_answer', 'ready'])
const amount = (value: unknown) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0 }

/**
 * Підсумок відкритих замовлень клієнта для каси. Та сама арифметика, що в панелі видачі:
 * до сплати = сума − знижка; внесено = більше з «оплачено» і «передоплата» (це одні й ті самі гроші, не сума).
 */
export function customerOrdersSummary(orders: readonly CustomerOrderMoney[]): { count: number; ready: number; paid: number; due: number } {
  let count = 0, ready = 0, paid = 0, due = 0
  for (const order of orders) {
    if (CLOSED.has(order.status)) continue
    const payable = Math.max(0, amount(order.total_amount) - amount(order.discount_amount))
    const received = Math.min(payable, Math.max(amount(order.total_paid), amount(order.prepayment)))
    count += 1
    if (READY.has(order.status)) ready += 1
    paid += received
    due += payable - received
  }
  return { count, ready, paid, due }
}
