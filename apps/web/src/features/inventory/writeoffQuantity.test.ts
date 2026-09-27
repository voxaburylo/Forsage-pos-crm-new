import { describe, expect, it } from 'vitest'
import { parseWriteoffQuantity, writeoffQuantityStep } from './writeoffQuantity'
describe('writeoff quantity editing', () => {
  it('accepts multi-digit quantities and old numeric drafts without clamping', () => {
    for (const value of ['2', '12', '200', 12]) expect(parseWriteoffQuantity(value)).toBe(Number(value))
  })
  it('supports clearing the input and rejects invalid quantities before submission', () => {
    for (const value of ['', ' ', '0', '-1', 'NaN', 'Infinity', '1x']) expect(parseWriteoffQuantity(value)).toBeNull()
  })
  it('supports fractions and unit-appropriate arrow increments', () => {
    expect(parseWriteoffQuantity('2,125')).toBe(2.125)
    for (const unit of ['шт', 'шт.', 'компл', 'пара']) expect(writeoffQuantityStep(unit)).toBe(1)
    for (const unit of ['кг', 'л', 'м']) expect(writeoffQuantityStep(unit)).toBe(0.001)
  })
})
