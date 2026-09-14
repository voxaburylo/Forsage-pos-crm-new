import { afterEach, expect, it } from 'vitest'
import { isDesktopAccessLocked, setDesktopAccessLocked } from './desktopAccessState'
afterEach(() => setDesktopAccessLocked(false))
it('pauses background reads until the access gate explicitly unlocks', () => {
  setDesktopAccessLocked(true)
  expect(isDesktopAccessLocked()).toBe(true)
  setDesktopAccessLocked(true)
  expect(isDesktopAccessLocked()).toBe(true)
  setDesktopAccessLocked(false)
  expect(isDesktopAccessLocked()).toBe(false)
})
