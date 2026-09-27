import type { LocalSaleCheckoutInput } from '../../db/localTypes'
const MAX_MONEY = 2_147_483_647
export function assertSaleMoney(value: unknown, code = 'LOCAL_SALE_INVALID_AMOUNT'): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Math.round(value) > MAX_MONEY) throw new Error(code)
}
/** Validate before hashing: NaN/Infinity must not become the same request as zero. */
export function assertCheckoutPayload(input: LocalSaleCheckoutInput): void {
  if (!input || !Array.isArray(input.items) || !input.items.length) throw new Error('LOCAL_SALE_EMPTY')
  if (!Array.isArray(input.payments) || !input.payments.length) throw new Error('LOCAL_SALE_PAYMENT_REQUIRED')
  assertSaleMoney(input.discount ?? 0, 'LOCAL_SALE_INVALID_DISCOUNT')
  assertSaleMoney(input.bonuses_spent ?? 0, 'LOCAL_SALE_INVALID_BONUS')
  for (const item of input.items) {
    if (!item || typeof item.qty !== 'number' || !Number.isFinite(item.qty) || item.qty <= 0 || item.qty > Number.MAX_SAFE_INTEGER)
      throw new Error('LOCAL_SALE_INVALID_QTY')
    if (item.unit_price !== undefined) assertSaleMoney(item.unit_price, 'LOCAL_SALE_INVALID_PRICE')
    assertSaleMoney(item.discount ?? 0, 'LOCAL_SALE_INVALID_DISCOUNT')
  }
  for (const payment of input.payments) {
    if (!payment || !['cash', 'card', 'transfer', 'debt'].includes(payment.method)) throw new Error('LOCAL_SALE_INVALID_PAYMENT_METHOD')
    assertSaleMoney(payment.amount)
    if (payment.method === 'debt' && payment.amount > 0 && !input.customer_id) throw new Error('Для продажу в борг виберіть клієнта')
  }
}
