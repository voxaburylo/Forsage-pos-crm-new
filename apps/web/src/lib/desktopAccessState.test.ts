import { afterEach, expect, it } from 'vitest'
import { isDesktopAccessLocked, setDesktopAccessLocked, desktopUnlockRevision, confirmDesktopUnlocked } from './desktopAccessState'
afterEach(() => setDesktopAccessLocked(false))
it('pauses background reads until the access gate explicitly unlocks', () => {
  setDesktopAccessLocked(true)
  expect(isDesktopAccessLocked()).toBe(true)
  setDesktopAccessLocked(true)
  expect(isDesktopAccessLocked()).toBe(true)
  setDesktopAccessLocked(false)
  expect(isDesktopAccessLocked()).toBe(false)
})
it('invalidates old status replies on every confirmed login, including already unlocked state', () => {
  const before = desktopUnlockRevision()
  setDesktopAccessLocked(true)
  expect(desktopUnlockRevision()).toBe(before)
  confirmDesktopUnlocked()
  expect(isDesktopAccessLocked()).toBe(false)
  expect(desktopUnlockRevision()).toBe(before + 1)
  confirmDesktopUnlocked()
  expect(desktopUnlockRevision()).toBe(before + 2)
})
