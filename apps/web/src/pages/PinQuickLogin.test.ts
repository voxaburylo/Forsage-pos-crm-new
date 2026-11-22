import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { pinDigits } from './PinQuickLogin'

describe('PIN quick login (stage 9, owner decision 22.11.2026)', () => {
  it('keeps only four digits', () => {
    expect(pinDigits('12a3 4567')).toBe('1234')
    expect(pinDigits('')).toBe('')
  })
  it('is offered on the login screen and in the cashier switch, and the staff card can set a PIN', () => {
    const login = readFileSync(new URL('./LoginPage.tsx', import.meta.url), 'utf8')
    expect(login).toContain('<PinQuickLogin')
    const modal = readFileSync(new URL('../features/pos/CashierSwitchModal.tsx', import.meta.url), 'utf8')
    expect(modal).toContain('<PinQuickLogin')
    const staff = readFileSync(new URL('../features/staff/StaffPage.tsx', import.meta.url), 'utf8')
    expect(staff).toContain('<StaffPinControl')
  })
})
