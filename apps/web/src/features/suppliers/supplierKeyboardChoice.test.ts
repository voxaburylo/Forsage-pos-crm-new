import { describe, expect, it } from 'vitest'
import { supplierKeyboardChoice } from './supplierKeyboardChoice'

const rows = [{ id: 'a', name: 'Авто Комфорт', phone: '+380671234567' }, { id: 'b', name: 'Комфорт Плюс' }]
describe('supplier keyboard confirmation', () => {
  it.each(['авто комфорт', ' АВТО  КОМФОРТ ', '067 123 45 67', '+380 (67) 123-45-67'])('accepts unique exact name/phone %s', query => {
    expect(supplierKeyboardChoice(rows, query, -1, true)?.id).toBe('a')
  })
  it.each(['комф', '067', ''])('does not silently pick the first fuzzy match %s', query => {
    expect(supplierKeyboardChoice(rows, query, -1, true)).toBeUndefined()
  })
  it('requires an explicit choice when exact names are duplicated or not all pages were loaded', () => {
    expect(supplierKeyboardChoice([...rows, { id: 'c', name: 'Авто Комфорт' }], rows[0].name, -1, true)).toBeUndefined()
    expect(supplierKeyboardChoice(rows, rows[0].name, -1, false)).toBeUndefined()
    expect(supplierKeyboardChoice(rows, 'комф', 1, false)?.id).toBe('b')
  })
})
