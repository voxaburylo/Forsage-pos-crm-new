import { describe, expect, it } from 'vitest'
import { shiftMonthKey, stockQuantity } from './documentInput'
describe('warehouse form values', () => {
  it.each(['', '0', '-1', '1abc', 'Infinity', '1.2345'])('does not silently convert %s to one unit', value => expect(stockQuantity(value)).toBeNull())
  it('supports fractional quantities with comma', () => expect(stockQuantity('0,125')).toBe(0.125))
  it('changes months without timezone off-by-one', () => {
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12')
    expect(shiftMonthKey('2026-12', 1)).toBe('2027-01')
  })
})
