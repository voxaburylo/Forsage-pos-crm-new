import { describe, expect, it } from 'vitest'
import { InventoryInputGuard, parseInventoryNumber } from './inventoryInput'

describe('explicit inventory numbers', () => {
  it.each(['', ' ', '-', '.', ',', '1.', '1,', '-1', 'NaN', 'Infinity', '1e3', '0x10', '1,2,3'])(
    'rejects incomplete input %j', value => expect(parseInventoryNumber(value)).toBeNull(),
  )
  it.each([['0', 0], ['3', 3], [' 12 ', 12], ['1,5', 1.5], ['0.25', 0.25], ['.5', 0.5]] as const)(
    'accepts explicit %s', (value, expected) => expect(parseInventoryNumber(value)).toBe(expected),
  )
  it('blocks repeated completion until corrected', () => {
    const guard = new InventoryInputGuard()
    guard.validate('revision', 'row', 'qty', '')
    expect(guard.hasErrors('revision')).toBe(true)
    expect(guard.hasErrors('revision')).toBe(true)
    guard.validate('revision', 'row', 'qty', '0')
    expect(guard.hasErrors('revision')).toBe(false)
  })
  it('keeps other fields and revisions isolated', () => {
    const guard = new InventoryInputGuard()
    guard.validate('a', 'row', 'qty', '')
    guard.validate('a', 'row', 'price', '')
    guard.validate('b', 'row', 'qty', '')
    guard.validate('a', 'row', 'qty', '2')
    expect(guard.hasErrors('a')).toBe(true)
    guard.removeItem('a', 'row')
    expect(guard.hasErrors('a')).toBe(false)
    expect(guard.hasErrors('b')).toBe(true)
  })
})
