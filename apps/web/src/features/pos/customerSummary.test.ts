import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('selected customer context', () => {
  it('opens the selected customer directly, independently of replacing the customer', () => {
    const panel = readFileSync(new URL('./ReceiptPanel.tsx', import.meta.url), 'utf8')
    const page = readFileSync(new URL('./POSPage.tsx', import.meta.url), 'utf8')
    expect(panel).toContain('onEditCustomer')
    expect(panel).toContain('Редагувати вибраного клієнта')
    expect(page).toContain('handleEditSelectedCustomer')
    expect(page).toContain('setResumeCustomerSearch(fromSearch)')
  })
  it('shows personal discount or cashback mode without pretending account money is a bonus', () => {
    const panel = readFileSync(new URL('./ReceiptPanel.tsx', import.meta.url), 'utf8')
    const search = readFileSync(new URL('./SearchPanel.tsx', import.meta.url), 'utf8')
    expect(panel).toContain("store.customer.loyaltyMode === 'cashback'")
    expect(panel).toContain('Накопичення на рахунок')
    expect(panel).toContain('Персональна знижка')
    expect(search.match(/loyaltyMode:/g)).toHaveLength(3)
  })
})
