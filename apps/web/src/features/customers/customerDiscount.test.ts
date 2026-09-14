import { describe, expect, it } from 'vitest'
import { customerDiscountPct } from './customerDiscount'
describe('one customer discount policy for search, scanner and edited cards', () => {
  it('uses the personal discount without a group', () => { expect(customerDiscountPct({ discount_pct: 7.25 })).toBe(7.25) })
  it('uses an explicitly chosen group, including its zero discount', () => {
    expect(customerDiscountPct({ discount_pct: 5, price_tier: { discount_pct: 10 } })).toBe(10)
    expect(customerDiscountPct({ discount_pct: 5, price_tier: { discount_pct: 0 } })).toBe(0)
  })
  it('does not turn cashback into a price discount', () => { expect(customerDiscountPct({ loyalty_mode: 'cashback', discount_pct: 5, price_tier: {discount_pct:10} })).toBe(0) })
  it('bounds invalid legacy data', () => {
    for (const value of [NaN, Infinity, -5]) expect(customerDiscountPct({discount_pct:value})).toBe(0)
    expect(customerDiscountPct({discount_pct:110})).toBe(100)
  })
})
