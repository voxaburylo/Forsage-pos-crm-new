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
  it('does not forget a failed save after validation or a repeated completion attempt', () => {
    const guard = new InventoryInputGuard()
    guard.markSaveFailed('a','row','qty')
    expect(guard.validate('a','row','qty','12')).toBe(12)
    expect(guard.hasErrors('a')).toBe(true)
    expect(guard.hasErrors('a')).toBe(true)
    guard.markSaved('a','row','purchase')
    expect(guard.failedSaveCount('a')).toBe(1)
    guard.markSaved('a','row','qty')
    expect(guard.hasErrors('a')).toBe(false)
  })
  it('removes failed fields only with their own deleted row', () => {
    const guard = new InventoryInputGuard()
    guard.markSaveFailed('a','row','qty')
    guard.markSaveFailed('b','row','qty')
    guard.removeItem('a','row')
    expect(guard.hasErrors('a')).toBe(false)
    expect(guard.hasErrors('b')).toBe(true)
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
