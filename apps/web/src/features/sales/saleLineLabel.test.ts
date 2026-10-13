import { expect, it } from 'vitest'
import { saleLineLabel } from './saleLineLabel'

it('keeps the current known product name, with original text as fallback only', () => {
  expect(saleLineLabel({ product: { id: 'p', name: 'Назва з бази', sku: 'P', unit: 'шт' }, description: 'Історична назва' })).toBe('Назва з бази')
})
it('preserves meaningful custom/free-price line text without a product reference', () => {
  expect(saleLineLabel({ description: '  Додаткова робота, демонтаж  ', sku: 'WORK' })).toBe('Додаткова робота, демонтаж')
})
it('falls back through original SKU without displaying an invented identifier', () => {
  expect(saleLineLabel({ description: ' ', sku: 'OLD-123' })).toBe('OLD-123')
  expect(saleLineLabel({})).toBe('Назва недоступна в історичному записі')
})
