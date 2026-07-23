import { describe, expect, it } from 'vitest'
import { normalizeExactBarcode, normalizeExactProductName } from './productIdentity.js'

describe('supplier product identity normalization', () => {
  it('keeps an exact barcode while removing spreadsheet formatting', () => {
    expect(normalizeExactBarcode(' 2003 0935-55486 ')).toBe('2003093555486')
    expect(normalizeExactBarcode('2003093555486.0')).toBe('2003093555486')
  })

  it('expands safe spreadsheet scientific notation', () => {
    expect(normalizeExactBarcode('2.003093555486e+12')).toBe('2003093555486')
  })

  it('normalizes Ukrainian and Russian spelling only for full-name equality', () => {
    expect(normalizeExactProductName('  Пускові дроти — для АКБ  '))
      .toBe(normalizeExactProductName('Пускови дроти для АКБ'))
  })

  it('does not make different product variants equal', () => {
    expect(normalizeExactProductName('Рулетка 5м Greener'))
      .not.toBe(normalizeExactProductName('Рулетка 7.5м Greener'))
  })
})
