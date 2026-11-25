import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { initialSettlementMode } from './DebtPaymentModal'

const posSource = readFileSync(new URL('./POSPage.tsx', import.meta.url), 'utf8')
const customerSource = readFileSync(new URL('../customers/QuickCustomerModal.tsx', import.meta.url), 'utf8')
const debtSource = readFileSync(new URL('./DebtPaymentModal.tsx', import.meta.url), 'utf8')
const chipSource = readFileSync(new URL('./CustomerOrdersChip.tsx', import.meta.url), 'utf8')
const ordersSource = readFileSync(new URL('./ReadyOrdersPanel.tsx', import.meta.url), 'utf8')

describe('unified POS customer flow', () => {
  it('keeps one customer-settlements window; the toolbar opens it on the debtors list (owner 25.11.2026)', () => {
    expect(posSource).not.toContain('> Оплата боргу')
    expect(posSource).toContain('onPayDebt={(c) =>')
    expect(posSource).toContain("setDebtCustomer(null); setDebtMode('debt'); setDebtPayOpen(true)")
    expect(posSource).toContain('{desktopRuntime && (')
  })

  it('offers one customer-money action for debt, orders, top-up and payout', () => {
    expect(customerSource).toContain('Розрахунки клієнта: борг, замовлення (передоплата, видача), рахунок')
    expect(customerSource).toContain('onPayDebt(c)')
    expect(debtSource).toContain("{ id: 'payout', label: 'Зняти з рахунку' }")
    expect(debtSource).toContain('posCustomerMoneyApi.payOutDeposit')
    expect(debtSource).toContain('Розрахунки клієнта')
  })

  it('opens debt payment with the customer already selected', () => {
    expect(posSource).toContain('initialCustomer={debtCustomer}')
    expect(posSource).toContain('initialMode={debtMode}')
    expect(debtSource).toContain('initialCustomer?: MoneyCustomer | null')
    expect(debtSource).toContain('setSelected(initialCustomer)')
  })

  it('the orders tab reuses the till order panel: same payment, deposit and handover code, not a copy', () => {
    expect(debtSource).toContain('<ReadyOrdersPanel embeddedCustomerId={selected.id}')
    expect(debtSource).not.toContain('posOrderApi')
    // Вбудований список не перехоплює сканер, штрихкод замовлення й посилання — це робить вікно і головна панель.
    expect(ordersSource).toContain('if (embedded || !(open || isMobileInline)) return')
    expect(ordersSource.match(/if \(embedded\) return/g)?.length).toBe(2)
  })

  it('the receipt debt is a button at the till that opens the settlements window on the right tab', () => {
    expect(chipSource).toContain('data-customer-debt-pay')
    expect(chipSource).toContain("settle('debt')")
    expect(chipSource).toContain("const open = () => settle('orders')")
    expect(chipSource).toContain("next.set('customerMoneyTab', tab)")
    expect(posSource).toContain("next.delete('customerMoneyTab')")
  })
})

describe('initial settlements tab', () => {
  const customer = (debt: number, deposit = 0) => ({ id: 'c', full_name: null, phone: null, debt_balance: debt, deposit_balance: deposit })
  const base = { ordersAvailable: true, canPayout: true }

  it('follows the button the cashier pressed', () => {
    expect(initialSettlementMode(customer(500), { ...base, requested: 'orders' })).toBe('orders')
    expect(initialSettlementMode(customer(0), { ...base, requested: 'debt' })).toBe('debt')
  })

  it('without a request: debt first, then payout of the account, then top-up', () => {
    expect(initialSettlementMode(customer(500, 100), base)).toBe('debt')
    expect(initialSettlementMode(customer(0, 100), base)).toBe('payout')
    expect(initialSettlementMode(customer(0, 0), base)).toBe('deposit')
  })

  it('never opens a tab the till cannot show', () => {
    expect(initialSettlementMode(customer(0), { ordersAvailable: false, canPayout: true, requested: 'orders' })).toBe('deposit')
    expect(initialSettlementMode(customer(0, 100), { ordersAvailable: true, canPayout: false, requested: 'payout' })).toBe('deposit')
  })
})
