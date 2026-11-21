import { expect, it } from 'vitest'
import { liteModeActive, weakDevice } from './liteMode'

it('turns on automatically on a weak PC and obeys the manual switch', () => {
  expect(weakDevice({ hardwareConcurrency: 2, deviceMemory: 8 })).toBe(true)
  expect(weakDevice({ hardwareConcurrency: 8, deviceMemory: 4 })).toBe(true)
  expect(weakDevice({ hardwareConcurrency: 8, deviceMemory: 8 })).toBe(false)
  expect(liteModeActive('auto', { hardwareConcurrency: 2 })).toBe(true)
  expect(liteModeActive('off', { hardwareConcurrency: 2 })).toBe(false)
  expect(liteModeActive('on', { hardwareConcurrency: 16, deviceMemory: 32 })).toBe(true)
})
