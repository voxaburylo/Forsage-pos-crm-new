import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CustomerCreationLoyaltyFields } from './CustomerCreationLoyaltyFields'

const base = { mode: 'discount' as const, discount: '5', tierId: '', tiers: [{ id: 'tier', name: 'СТО', discount_pct: 10 }], onModeChange: () => {}, onDiscountChange: () => {}, onTierChange: () => {} }

describe('creation fields visible rule and permissions', () => {
  it.each(['owner', 'admin', 'manager'])('%s sees the existing mode selector at creation', (role) => {
    const html = renderToStaticMarkup(<CustomerCreationLoyaltyFields {...base} role={role} />)
    expect(html).toContain('Процент працює як')
    expect(html).toContain('Накопичення на рахунок')
    expect(html).toContain('Персональна знижка з картки')
    expect(html).not.toContain('Стандартна ціна (роздріб)')
  })
  it('explains price-group precedence over a personal percentage', () => {
    const html = renderToStaticMarkup(<CustomerCreationLoyaltyFields {...base} role="manager" tierId="tier" />)
    expect(html).toContain('«СТО» — 10%')
    expect(html).toContain('Для персональної знижки виберіть її у списку вище')
  })
  it('distinguishes cashback from a price discount and bonus balance', () => {
    const html = renderToStaticMarkup(<CustomerCreationLoyaltyFields {...base} role="owner" mode="cashback" />)
    expect(html).toContain('Накопичення (%)')
    expect(html).toContain('Ціна в чеку не зменшується')
    expect(html).toContain('Бонуси — окремий баланс')
    expect(html).not.toContain('знижка цінової групи')
  })
  it('cashier can set personal discount but cannot choose mode or group', () => {
    const html = renderToStaticMarkup(<CustomerCreationLoyaltyFields {...base} role="cashier" mode="cashback" tierId="tier" />)
    expect(html).not.toContain('<select')
    expect(html).not.toContain('disabled=""')
    expect(html).toContain('Персональна знижка (%)')
    expect(html).toContain('не надає права на ручну знижку в чеку')
  })
  it('non-editor does not gain a writable percentage', () => {
    const html = renderToStaticMarkup(<CustomerCreationLoyaltyFields {...base} role="viewer" />)
    expect(html).not.toContain('<select')
    expect(html).toContain('disabled=""')
  })
})
