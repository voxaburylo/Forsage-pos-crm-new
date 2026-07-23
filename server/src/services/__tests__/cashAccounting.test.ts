import { describe, expect, it } from 'vitest'
import { calculateExpectedCash, summarizePaymentReceipts } from '../cashAccounting.js'

describe('summarizePaymentReceipts', () => {
  it('does not count the completed order receipt a second time', () => {
    const result = summarizePaymentReceipts(
      [{
        id: 'order-sale',
        total: 50_000,
        payment_method: 'cash',
        cash_amount: 50_000,
      }],
      new Set(['order-sale']),
      [{ amount: 50_000, method: 'cash' }],
    )

    expect(result.cash).toBe(50_000)
    expect(result.total).toBe(50_000)
  })

  it('uses the payments supplied for their own date or shift', () => {
    const issueShift = summarizePaymentReceipts(
      [{ id: 'order-sale', total: 20_000, payment_method: 'card', card_amount: 20_000 }],
      new Set(['order-sale']),
      [],
    )
    const paymentShift = summarizePaymentReceipts([], new Set(), [
      { amount: 5_000, method: 'cash' },
      { amount: 10_000, method: 'card' },
      { amount: 3_000, method: 'transfer' },
      { amount: 2_000, method: 'account' },
    ])

    expect(issueShift.total).toBe(0)
    expect(paymentShift).toMatchObject({
      cash: 5_000,
      card: 10_000,
      transfer: 3_000,
      account: 2_000,
      total: 20_000,
    })
  })

  it('keeps debt in the method breakdown but not in received money', () => {
    const result = summarizePaymentReceipts([
      {
        id: 'mixed-sale',
        total: 20_000,
        payment_method: 'mixed',
        cash_amount: 5_000,
        card_amount: 4_000,
        transfer_amount: 3_000,
        debt_amount: 8_000,
      },
      { id: 'transfer-sale', total: 1_500, payment_method: 'transfer' },
      { id: 'debt-sale', total: 2_500, payment_method: 'debt' },
    ], new Set(), [])

    expect(result).toMatchObject({
      cash: 5_000,
      card: 4_000,
      transfer: 4_500,
      debt: 10_500,
      total: 13_500,
    })
  })
})

describe('calculateExpectedCash', () => {
  it('subtracts a return movement once from the shift where it happened', () => {
    expect(calculateExpectedCash({
      openingCash: 10_000,
      regularSaleCash: 5_000,
      cashIn: 1_000,
      returnCash: 2_000,
      cashOut: 500,
    })).toBe(13_500)
  })
})
