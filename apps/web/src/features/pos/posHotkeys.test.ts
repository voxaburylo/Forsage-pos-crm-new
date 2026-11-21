import { expect, it } from 'vitest'
import { posHotkeyAction } from './posHotkeys'

it('maps till F-keys and leaves scanner/reload keys alone', () => {
  expect(posHotkeyAction('F2', true)).toBe('pay')
  expect(posHotkeyAction('F2', false)).toBeNull()
  expect(posHotkeyAction('F3', false)).toBe('customer')
  expect(posHotkeyAction('F4', true)).toBe('suspend')
  expect(posHotkeyAction('F8', false)).toBe('suspended')
  expect(posHotkeyAction('F9', false)).toBe('find-receipt')
  expect(posHotkeyAction('F1', false)).toBe('help')
  for (const key of ['F5', 'F7', 'F11', 'F12', 'Enter']) expect(posHotkeyAction(key, true)).toBeNull()
})
