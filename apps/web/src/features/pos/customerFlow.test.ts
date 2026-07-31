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

  it('offers debt payment directly beside a matching customer', () => {
    expect(customerSource).toContain('c.debt_balance > 0')
    expect(customerSource).toContain('Сплатити борг')
    expect(customerSource).toContain('onPayDebt(c)')
  })

  it('opens debt payment with the customer already selected', () => {
    expect(posSource).toContain('initialCustomer={debtCustomer}')
    expect(debtSource).toContain('initialCustomer?: MoneyCustomer | null')
    expect(debtSource).toContain('setSelected(initialCustomer)')
  })
})
