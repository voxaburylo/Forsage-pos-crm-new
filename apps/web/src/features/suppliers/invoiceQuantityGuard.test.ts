import { describe, expect, it } from 'vitest'
import { applyManualInvoiceQuantities, parseManualInvoiceQuantity } from './invoiceQuantityGuard'

describe('invoice quantity guard', () => {
  it('keeps the last quantity physically entered by the user', () => {
    const rows = [{ client_key: 'row-1', qty: 1, purchase_price: 90000, total: 90000 }]
    const result = applyManualInvoiceQuantities(rows, new Map([['row-1', 8]]))
    expect(result[0]).toMatchObject({ qty: 8, total: 720000 })
  })

  it('accepts comma decimal input and rejects invalid values', () => {
    expect(parseManualInvoiceQuantity('8')).toBe(8)
    expect(parseManualInvoiceQuantity('1,5')).toBe(1.5)
    expect(parseManualInvoiceQuantity('-1')).toBe(0)
    expect(parseManualInvoiceQuantity('abc')).toBe(0)
  })
})
