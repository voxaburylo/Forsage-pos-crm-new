import { expect, it } from 'vitest'
import { invoiceActions, invoiceActionError } from './invoiceActions'
it('cancelled invoice has no debt, payment, delete or posting action', () => {
  expect(invoiceActions({ status: 'cancelled', total: 666726, paid_amount: 0 }, 'owner')).toEqual({ debt: 0, cancelled: true, canDelete: false, canPay: false, canPost: false, canCancel: false })
})
it('only unpaid drafts can be deleted; posted and paid documents keep their history', () => {
  expect(invoiceActions({ status: 'draft', total: 100, paid_amount: 0 }, 'owner').canDelete).toBe(true)
  expect(invoiceActions({ status: 'draft', total: 100, paid_amount: 50 }, 'owner').canDelete).toBe(false)
  expect(invoiceActions({ status: 'posted', total: 100, paid_amount: 0 }, 'owner').canDelete).toBe(false)
  expect(invoiceActions({ status: 'posted', total: 100, paid_amount: 50 }, 'owner').canCancel).toBe(false)
})
it('supports cashier invoice payments without offering forbidden reversals', () => {
  const actions = invoiceActions({ status: 'posted', total: 100, paid_amount: 20 }, 'cashier')
  expect(actions.debt).toBe(80)
  expect(actions.canPay).toBe(true)
  expect(actions.canCancel).toBe(false)
})
it('shows the actual localized reason instead of a generic deletion error', () => {
  expect(invoiceActionError(new Error("Error invoking remote method 'desktop:supply:delete-invoice': Error: Видалити можна лише неоплачену чернетку"), 'Помилка'))
    .toBe('Видалити можна лише неоплачену чернетку')
})
