import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseSupplyText, supplyImportAction } from './aiSupplyImport'
const fixture = readFileSync(new URL('../../../scripts/fixtures/clipboard-supply-blocks.txt', import.meta.url), 'utf8')
const block = (qty = '1 шт.', price = '141 грн/шт.') => `1. Ключ 18″
Розміри: 17, 19, 21 і 23 мм.
Кількість: ${qty}
Закупівля: ${price}
Ціна продажу: 550 грн/шт.`

describe('Labeled clipboard descriptions, no AI inference', () => {
  it('parses all four owner examples, preserves differences, does not invent articles', () => {
    const parsed = parseSupplyText(fixture.replace(/\n/g, '\r\n'))
    expect(parsed.products).toHaveLength(4)
    expect(parsed.products.map(p=>p.qty)).toEqual([1,1,1,1])
    expect(parsed.products.map(p=>p.purchase_price_uah)).toEqual([141,162,165,186])
    expect(new Set(parsed.products.map(p=>p.name)).size).toBe(4)
    expect(parsed.products.map(p=>p.name)).toEqual([
      'Хрестовий балонний ключ 18″ — стандартний', 'Хрестовий балонний ключ 18″ — посилений',
      'Хрестовий балонний ключ 20″ — стандартний', 'Хрестовий балонний ключ 20″ — посилений',
    ])
    expect(parsed.products.every(p=>!p.sku && !p.barcode && !('retail_price_uah' in p))).toBe(true)
    expect(parsed.products[0].source_name).toContain('17, 19, 21 і 23 мм.')
    expect(parsed.products[0].source_name).not.toContain('550')
    expect(parsed.products[3].purchase_price_note).toContain('орієнтовна')
    expect(parsed.products[3].purchase_price_note).toContain('186')
    expect(parsed.products[0].purchase_price_note).toBeUndefined()
    expect(parsed.sourceCurrency).toBeUndefined()
    const action = supplyImportAction(parsed.products, 'Буфер')
    expect(action.payload.notes).toContain('орієнтовна')
    expect(action.payload.notes).toContain(parsed.products[3].name)
    expect(action.payload.products.reduce((sum: number,p: {qty:number;purchase_price_uah:number})=>sum+p.qty*p.purchase_price_uah,0)).toBe(654)
  })
  it.each(['1.', '1)', '1️⃣'])('supports heading %s and markdown bold', heading => {
    expect(parseSupplyText(block().replace('1.', heading).replace('Кількість:', '**Кількість:**')).products[0].qty).toBe(1)
  })
  it('does not mistake sizes at the start of a description for product headings', () => {
    expect(parseSupplyText(block().replace('Розміри: ', '')).products).toHaveLength(1)
  })
  it('accepts Russian labels, explicit codes and decimal kg unit prices', () => {
    const parsed = parseSupplyText('1) Смазка\nКоличество: 1,5 кг\nЗакупочная цена: 120,50 грн за кг\nАртикул: 001\nШтрихкод: 0123456789012\nБренд: TEST')
    expect(parsed.products[0]).toMatchObject({qty:1.5,purchase_price_uah:120.5,sku:'001',barcode:'0123456789012',brand:'TEST',unit:'кг'})
  })
  it.each(['0', '-1', 'невідомо', '1-2', 'приблизно 1', '1 коробка'])('rejects ambiguous quantity %s', qty => {
    expect(()=>parseSupplyText(block(qty))).toThrow('кількість')
  })
  it.each(['', 'невідомо', '100-150 грн', '120 грн/уп.', 'ціна 120 грн', '186 ± 10 грн'])('rejects invalid price %s', price => {
    expect(()=>parseSupplyText(block('1', price))).toThrow('ціну')
  })
  it('rejects missing and duplicate fields without dropping rows', () => {
    expect(()=>parseSupplyText(fixture.replace('Закупівля: 162 грн/шт.', ''))).toThrow('Товар 2')
    expect(()=>parseSupplyText(block()+'\nКількість: 2')).toThrow('по одному')
    expect(()=>parseSupplyText(block()+'\nЗакупівля: 2')).toThrow('по одному')
    expect(()=>parseSupplyText(block()+'\nАртикул: 001\nАртикул: 002')).toThrow('повторюється')
    expect(()=>parseSupplyText(fixture.replace('3️⃣','5️⃣'))).toThrow('нумерація')
  })
  it('rejects mismatched price units', () => {
    expect(()=>parseSupplyText(block('2 шт.', '120 грн/кг'))).toThrow('одиниця')
  })
  it('never derives a purchase price from a retail-only list', () => {
    const parsed = parseSupplyText(block().replace('Закупівля: 141 грн/шт.\n',''))
    expect(parsed.products).toEqual([])
  })
  it('distinguishes purchasing currency from a retail currency', () => {
    expect(parseSupplyText(block().replace('550 грн', '550 USD')).sourceCurrency).toBeUndefined()
    const parsed = parseSupplyText(block('1 шт.', '10 USD/шт.'))
    expect(parsed.sourceCurrency).toBe('USD')
    expect(parsed.products[0].purchase_price_uah).toBe(10)
    expect(()=>parseSupplyText(fixture.replace('141 грн', '141 USD'))).toThrow('кілька валют')
  })
})
