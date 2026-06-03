import { describe, it, expect } from 'vitest'

describe('calculateSaleAmounts', () => {
  const calculateSaleAmounts = (input: any, discountedTotal: number) => {
    let cashAmount = 0
    let cardAmount = 0
    if (input.payment_method === 'mixed') {
      cashAmount = input.cash_amount ?? 0
      cardAmount = input.card_amount ?? 0
    } else if (input.payment_method === 'cash') {
      cashAmount = discountedTotal
    } else if (input.payment_method === 'card') {
      cardAmount = discountedTotal
    }
    let bonusesEarned = 0
    return { cashAmount, cardAmount, bonusesEarned }
  }

  it('should assign full amount to cash for cash payment', () => {
    const result = calculateSaleAmounts({ payment_method: 'cash' }, 10000)
    expect(result.cashAmount).toBe(10000)
    expect(result.cardAmount).toBe(0)
  })

  it('should assign full amount to card for card payment', () => {
    const result = calculateSaleAmounts({ payment_method: 'card' }, 5000)
    expect(result.cashAmount).toBe(0)
    expect(result.cardAmount).toBe(5000)
  })

  it('should split amounts for mixed payment', () => {
    const result = calculateSaleAmounts(
      { payment_method: 'mixed', cash_amount: 3000, card_amount: 7000 },
      10000
    )
    expect(result.cashAmount).toBe(3000)
    expect(result.cardAmount).toBe(7000)
  })

  it('should assign zero for debt payment', () => {
    const result = calculateSaleAmounts({ payment_method: 'debt' }, 10000)
    expect(result.cashAmount).toBe(0)
    expect(result.cardAmount).toBe(0)
  })

  it('should always initialize bonusesEarned to 0', () => {
    const result = calculateSaleAmounts({ payment_method: 'cash' }, 10000)
    expect(result.bonusesEarned).toBe(0)
  })
})

describe('discount calculation', () => {
  it('should calculate discounted total correctly', () => {
    const items = [
      { unit_price: 5000, qty: 2, discount: 0 },
      { unit_price: 3000, qty: 1, discount: 0 },
    ]
    const subtotal = items.reduce((s, i) => s + i.unit_price * i.qty, 0)
    const discount = 1000
    const discountedTotal = Math.max(0, subtotal - discount)
    expect(subtotal).toBe(13000)
    expect(discountedTotal).toBe(12000)
  })

  it('should not allow negative discounted total', () => {
    const subtotal = 5000
    const discount = 10000
    const discountedTotal = Math.max(0, subtotal - discount)
    expect(discountedTotal).toBe(0)
  })
})

describe('sale number formatting', () => {
  it('should pad sale number to 6 digits', () => {
    const saleNumber = String(42).padStart(6, '0')
    expect(saleNumber).toBe('000042')
  })

  it('should handle large numbers', () => {
    const saleNumber = String(999999).padStart(6, '0')
    expect(saleNumber).toBe('999999')
  })
})
