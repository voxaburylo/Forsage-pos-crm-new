import { describe, expect, it } from 'vitest'
import { parseSupplyText } from './aiSupplyImport'

describe('ambiguous price column without a line total', () => {
  it('marks rows with qty > 1 when the price column says «за комплект»', () => {
    const text = '№\tАртикул\tНаименование товара\tКол-во\tЕд.\tЦена за комплект, ₴\n1\tVC-RCA-AY11\tY-розгалужувач Voice RCA-AY11\t2\tшт.\t226.72\n2\tVC-ANL-60\tЗапобіжник Voice ANL-60A\t1\tшт.\t90.69'
    const parsed = parseSupplyText(text)
    expect(parsed.products[0].purchase_price_note).toContain('ціна за одиницю чи за весь рядок')
    expect(parsed.products[1].purchase_price_note).toBeUndefined()
  })
})
