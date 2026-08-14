import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const posSource = readFileSync(new URL('./POSPage.tsx', import.meta.url), 'utf8')
const customerSource = readFileSync(new URL('../customers/QuickCustomerModal.tsx', import.meta.url), 'utf8')
const debtSource = readFileSync(new URL('./DebtPaymentModal.tsx', import.meta.url), 'utf8')

describe('unified POS customer flow', () => {
  it('does not keep a separate debt-search button in the cashier toolbar', () => {
    expect(posSource).not.toContain('> Оплата боргу')
    expect(posSource).toContain('onPayDebt={(c) =>')
  })

  it('offers one customer-money action for debt, top-up and payout', () => {
    expect(customerSource).toContain('title="Борг, поповнення або видача коштів клієнту"')
    expect(customerSource).toContain('Гроші')
    expect(customerSource).toContain('onPayDebt(c)')
    expect(debtSource).toContain("{ id: 'payout', label: 'Видати' }")
    expect(debtSource).toContain('posCustomerMoneyApi.payOutDeposit')
  })

  it('opens debt payment with the customer already selected', () => {
    expect(posSource).toContain('initialCustomer={debtCustomer}')
    expect(debtSource).toContain('initialCustomer?: MoneyCustomer | null')
    expect(debtSource).toContain('setSelected(initialCustomer)')
  })
})
