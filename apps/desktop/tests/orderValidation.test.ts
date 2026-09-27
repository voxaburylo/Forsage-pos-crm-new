import { expect, it } from 'vitest'
import { assertOrderItemAmounts, assertOrderTotal } from '../src/repositories/orderValidation'
it.each([NaN, Infinity, -1, 2_147_483_648])('rejects invalid order money %s, including procurement cost', price => {
  expect(() => assertOrderItemAmounts({ qty: 1, sell_price: 100, buy_price: price })).toThrow()
  expect(() => assertOrderItemAmounts({ qty: 1, sell_price: price })).toThrow()
  expect(() => assertOrderItemAmounts({ qty: 1, sell_price: 100, core_deposit_amount: price })).toThrow()
})
it('allows notes with zero price, but refuses overflowing quantities and summed totals', () => {
  expect(() => assertOrderItemAmounts({ qty: 1, sell_price: 0 })).not.toThrow()
  expect(() => assertOrderItemAmounts({ qty: 1e300, sell_price: 1e100 })).toThrow()
  expect(() => assertOrderTotal(2_147_483_648)).toThrow()
})
