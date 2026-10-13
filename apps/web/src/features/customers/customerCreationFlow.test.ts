import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('customer creation flow uses the existing loyalty rules', () => {
  it.each(['QuickCustomerModal.tsx', 'CustomerFormPage.tsx'])('%s offers the shared loyalty fields and saves role-safe values', (file) => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    expect(source).toContain('<CustomerCreationLoyaltyFields')
    expect(source).toContain('customerCreationLoyaltyPayload(')
    expect(source).not.toContain('Стандартна ціна (роздріб)')
  })

  it('prefills only a recognized phone when starting creation from POS search', () => {
    const source = readFileSync(new URL('QuickCustomerModal.tsx', import.meta.url), 'utf8')
    expect(source).toContain('customerPhoneFromSearch(query)')
    expect(source).not.toContain('setPhone(query.trim())')
  })

  it('does not describe account cashback as a bonus balance', () => {
    const source = readFileSync(new URL('QuickCustomerEditModal.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('Цей клієнт накопичує бонуси.')
    expect(source).toContain('Цей клієнт накопичує кошти на рахунку.')
  })
})
