import { describe, expect, it } from 'vitest'
import { unrelatedNames } from '../src/repositories/aiInvoiceIdentity'

// 25.11.2026 (накладна 11870): код постачальника «3883» брелока Citroen збігся з внутрішнім артикулом «3883»
// старої картки «Викрутка єлектрична ARIDOO» — картку перейменовано й переоцінено. Такий рядок — на перевірку.
describe('a code match with a completely different name is not linked automatically', () => {
  it('recognizes different goods', () => {
    expect(unrelatedNames('Брелок для ключів плетений Citroen 3883', 'Викрутка єлектрична ARIDOO')).toBe(true)
  })
  it('keeps the same goods named in Russian and Ukrainian or with a different word order', () => {
    expect(unrelatedNames('Winso Очисник скла Glass Cleaner Intense 810700 500мл', 'Winso Очиститель стекла Glass Cleaner Intense 810700 500мл')).toBe(false)
    expect(unrelatedNames('Трос буксирувальний 8т 6м Elegant', 'Трос буксировочный 8Т 5М Elegant Maxi')).toBe(false)
    expect(unrelatedNames('Фільтр масляний', 'Масляний фільтр')).toBe(false)
  })
  it('does not decide on names without words (codes only)', () => {
    expect(unrelatedNames('3883', 'Викрутка')).toBe(false)
  })
})
