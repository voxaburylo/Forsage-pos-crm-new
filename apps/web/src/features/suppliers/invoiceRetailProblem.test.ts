import { expect, it } from 'vitest'
import { invoiceLineRetailProblem, invoiceProductBase } from './invoiceFormModel'

const base = (retail: number) => invoiceProductBase({ name: 'Фільтр', sku: 'F-1', retail_price: retail })

it('flags a new product posted without markup', () => {
  expect(invoiceLineRetailProblem({ purchase_price: 10000, retail_price: 0 })).toBe('zero')
})
it('flags a retail price that is not above the purchase price', () => {
  expect(invoiceLineRetailProblem({ purchase_price: 10000, retail_price: 10000 })).toBe('not_above_purchase')
  expect(invoiceLineRetailProblem({ purchase_price: 10000, retail_price: 9000 })).toBe('not_above_purchase')
})
it('accepts a price above the purchase price', () => {
  expect(invoiceLineRetailProblem({ purchase_price: 10000, retail_price: 13000 })).toBeNull()
})
it('judges an empty line price by the card price that posting keeps', () => {
  expect(invoiceLineRetailProblem({ purchase_price: 10000, retail_price: 0, product_base: base(15000) })).toBeNull()
  expect(invoiceLineRetailProblem({ purchase_price: 10000, retail_price: 0, product_base: base(8000) })).toBe('not_above_purchase')
  expect(invoiceLineRetailProblem({ purchase_price: 10000, retail_price: 0, product_base: base(0) })).toBe('zero')
})
