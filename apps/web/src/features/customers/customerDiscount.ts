/** A selected price group takes precedence; cashback never reduces the receipt. */
export function customerDiscountPct(customer: {
  loyalty_mode?: string | null
  discount_pct?: number | null
  price_tier?: { discount_pct?: number | null } | null
}): number {
  if (customer.loyalty_mode === 'cashback') return 0
  const value = Number(customer.price_tier?.discount_pct ?? customer.discount_pct ?? 0)
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
}
