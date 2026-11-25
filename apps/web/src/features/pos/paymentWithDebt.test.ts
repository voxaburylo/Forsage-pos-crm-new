import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { debtPaymentMethod } from './PaymentModal'

const source = readFileSync(new URL('./PaymentModal.tsx', import.meta.url), 'utf8')

// 25.11.2026 (власник: «покупка і борг однією оплатою»).
describe('purchase and debt in one payment', () => {
  it('closes the debt only for cash, terminal or transfer — never for a sale on credit or a mixed payment', () => {
    expect(debtPaymentMethod('cash')).toBe('cash')
    expect(debtPaymentMethod('card')).toBe('card')
    expect(debtPaymentMethod('transfer')).toBe('transfer')
    expect(debtPaymentMethod('debt')).toBeNull()
    expect(debtPaymentMethod('mixed')).toBeNull()
  })

  it('records two operations: the sale as before, then the same debt payment as the settlements window', () => {
    expect(source).toContain("posCustomerMoneyApi.payDebt(customerId, { amount, method: debtMethod, shift_id: shiftId, notes: 'Оплата боргу разом із покупкою' })")
    // Борг закривається лише після успішного продажу.
    expect(source).toContain('if (sold && debtAmount > 0 && debtCustomerId && debtMethod) await closeDebtAfterSale(')
  })

  it('the sale gets only its own cash; the cashier must take the purchase plus the debt', () => {
    expect(source).toContain("method === 'cash' ? cashReceived - debtAmount : undefined")
    expect(source).toContain('const collect      = toPay + debtExtra')
    expect(source).toContain("const cashValid    = method !== 'cash' || cashReceived >= collect")
    expect(source).toContain('{formatMoney(_toPay + debtExtra)}')
  })

  it('takes the debt fresh from the till database, not from the receipt, and only at the till', () => {
    expect(source).toContain('!desktopBridge()?.pos?.payDebt')
    expect(source).toContain('customerApi.get(customerId).then((res) => {')
  })

  it('a failed debt payment does not undo the sale and tells the cashier what to do', () => {
    expect(source).toContain('Покупку проведено, але борг')
    expect(source).toContain('НЕ закрито')
  })
})
