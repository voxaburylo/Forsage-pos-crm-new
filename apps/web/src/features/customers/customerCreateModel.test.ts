import { describe, expect, it } from 'vitest'
import { customerCreationLoyaltyPayload, customerPhoneFromSearch } from './customerCreateModel'

describe('safe phone transfer from customer search', () => {
  it.each(['0671234567', '(067) 123-45-67', '380671234567', '+380 (67) 123-45-67', ' +380\u00a067\u00a0123\u00a045\u00a067 '])('transfers %s without a second entry', (input) => {
    expect(customerPhoneFromSearch(input)).toBe('+380671234567')
  })
  it.each(['', 'Іван', 'Іван 0671234567', 'WVWZZZ1KZAW123456', '5449000351081', '06712', '86121', '+48 123456789', 'тел. +380671234567', '+0671234567', '3806712345670', '067/123/45/67'])('does not copy non-phone query %s', (input) => {
    expect(customerPhoneFromSearch(input)).toBe('')
  })
})

describe('role-safe creation loyalty', () => {
  it.each(['owner', 'admin', 'manager'])('%s can choose accumulation at creation', (role) => {
    expect(customerCreationLoyaltyPayload(role, { discount_pct: '7,5', loyalty_mode: 'cashback', price_tier_id: 'tier' })).toEqual({ discount_pct: 7.5, loyalty_mode: 'cashback', price_tier_id: 'tier' })
  })
  it('preserves default discount and explicit no tier', () => {
    expect(customerCreationLoyaltyPayload('owner', { discount_pct: '0', loyalty_mode: 'discount', price_tier_id: '' })).toEqual({ discount_pct: 0, loyalty_mode: 'discount', price_tier_id: null })
  })
  it('cashier cannot gain accumulation or price-group rights by tampering with draft', () => {
    expect(customerCreationLoyaltyPayload('cashier', { discount_pct: '5', loyalty_mode: 'cashback', price_tier_id: 'tier' })).toEqual({ discount_pct: 5 })
  })
  it.each(['viewer', 'tire_worker', undefined])('does not send financial fields for %s', (role) => {
    expect(customerCreationLoyaltyPayload(role, { discount_pct: '99', loyalty_mode: 'cashback', price_tier_id: 'tier' })).toEqual({})
  })
  it.each(['NaN', 'Infinity', '-1', '100.1'])('rejects invalid percentage %s', (discount_pct) => {
    expect(() => customerCreationLoyaltyPayload('owner', { discount_pct, loyalty_mode: 'cashback', price_tier_id: '' })).toThrow('Відсоток')
  })
})
