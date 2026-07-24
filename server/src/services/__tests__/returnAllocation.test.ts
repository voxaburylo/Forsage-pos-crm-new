import { describe, expect, it } from 'vitest'
import { allocateReturnableLineTotals } from '../returnAllocation.js'

describe('allocateReturnableLineTotals', () => {
  it('allocates the amount actually paid after a receipt-level discount', () => {
    const result = allocateReturnableLineTotals(1_500, [
      { id: 'a', qty: 1, unit_price: 1_000 },
      { id: 'b', qty: 1, unit_price: 1_000 },
    ])

    expect(result.get('a')).toBe(750)
    expect(result.get('b')).toBe(750)
    expect([...result.values()].reduce((sum, value) => sum + value, 0)).toBe(1_500)
  })

  it('does not include a refundable core deposit in the product refund pool', () => {
    const result = allocateReturnableLineTotals(1_500, [
      { id: 'product', qty: 1, unit_price: 1_000, core_deposit_amount: 500 },
    ])

    expect(result.get('product')).toBe(1_000)
  })

  it('distributes integer remainders deterministically without losing a kopeck', () => {
    const result = allocateReturnableLineTotals(100, [
      { id: 'a', qty: 1, unit_price: 100 },
      { id: 'b', qty: 1, unit_price: 100 },
      { id: 'c', qty: 1, unit_price: 100 },
    ])

    expect([...result.values()]).toEqual([34, 33, 33])
    expect([...result.values()].reduce((sum, value) => sum + value, 0)).toBe(100)
  })
})
