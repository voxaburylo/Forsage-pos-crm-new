import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { MAX_SUPPLY_ROWS, normalizeSupplyRows, parseSupplyText, parseSupplyWorkbook } from './aiSupplyImport'

const table = (headers: string[], row: unknown[], prefix = '') => prefix + headers.join('\t') + '\n' + row.join('\t')
const basic = ['Назва', 'Кількість', 'Ціна']

describe('Supply source semantics: currency, adjustments and packaging', () => {
  it.each(['USD', 'EUR', 'PLN'])('keeps adjacent pre-header currency %s', currency => {
    expect(parseSupplyText(table(basic, ['Фільтр', 2, 10], 'Валюта\t' + currency + '\n')).sourceCurrency).toBe(currency)
  })
  it('detects the purchasing currency column and rejects mixed rows', () => {
    const source = table([...basic, 'Валюта'], ['Фільтр', 2, 10, 'USD'])
    expect(parseSupplyText(source).sourceCurrency).toBe('USD')
    expect(() => parseSupplyText(source + '\nКлюч\t1\t15\tUAH')).toThrow('кілька валют')
  })
  it('rejects an unsupported explicit currency rather than treating it as UAH', () => {
    expect(()=>parseSupplyText(table([...basic,'Валюта'],['Фільтр',2,10,'GBP']))).toThrow('валюту')
    expect(()=>parseSupplyText(table(basic,['Фільтр',2,10],'Валюта\tCNY\n'))).toThrow('валюту')
  })
  it('checks a line total whose header includes currency', () => {
    expect(parseSupplyText(table([...basic, 'Сума, USD'], ['Фільтр', 2, 10, 20])).sourceCurrency).toBe('USD')
    expect(() => parseSupplyText(table([...basic, 'Сума (грн)'], ['Фільтр', 2, 10, 15]))).toThrow('сумою рядка')
  })
  it.each(['Ціна без ПДВ', 'Ціна до знижки', 'Ціна за упаковку', 'Price excl. VAT', 'Price before discount'])('does not silently treat %s as final unit cost', header => {
    expect(() => parseSupplyText(table(['Назва', 'Кількість', header], ['Фільтр', 2, 100]))).toThrow('закупівельну ціну за одиницю')
  })
  it.each(['Знижка %', 'ПДВ %', 'Discount', 'Штук в упаковці'])('does not silently ignore populated %s', header => {
    expect(() => parseSupplyText(table([...basic, header], ['Фільтр', 2, 100, 10]))).toThrow()
  })
  it('permits explicit final prices, zero adjustments, and informational retail discounts', () => {
    expect(parseSupplyText(table(['Назва', 'Кількість', 'Ціна після знижки з ПДВ', 'Знижка %'], ['Фільтр', 2, 100, 0])).products[0].purchase_price_uah).toBe(100)
    expect(parseSupplyText(table(['Назва', 'Кількість', 'Ціна після знижки з ПДВ', 'Знижка %', 'ПДВ %'], ['Фільтр', 2, 100, 10, 20])).products[0].purchase_price_uah).toBe(100)
    expect(parseSupplyText(table([...basic, 'ПДВ'], ['Фільтр', 2, 100, '0,00 грн'])).products).toHaveLength(1)
    expect(parseSupplyText(table([...basic, 'Знижка продажу %'], ['Фільтр', 2, 100, 10])).products).toHaveLength(1)
  })
  it('does not hide an additive VAT footer but accepts explicitly included VAT', () => {
    const source = table([...basic, 'Сума'], ['Фільтр', 2, 100, 200])
    expect(() => parseSupplyText(source + '\nПДВ 20%\t\t\t40')).toThrow('ПДВ')
    expect(parseSupplyText(source + '\nУ тому числі ПДВ\t\t\t33,33').products).toHaveLength(1)
    expect(parseSupplyText(source + '\nБез ПДВ').products).toHaveLength(1)
    expect(() => parseSupplyText(source + '\nЗнижка 10%\t\t\t20')).toThrow('зниж')
  })
  it('does not discard adjustments from labeled clipboard blocks', () => {
    const source = '1. Фільтр\nКількість: 2 шт.\nЗакупівля: 100 грн/шт.'
    expect(() => parseSupplyText(source + '\nЗнижка: 10%')).toThrow('зниж')
    expect(() => parseSupplyText(source + '\nПДВ: 20%')).toThrow('ПДВ')
    expect(() => parseSupplyText(source + '\nШтук в упаковці: 12')).toThrow('упаков')
    expect(parseSupplyText(source + '\nЦіна продажу: 200 грн\nЗнижка продажу: 10%').products).toHaveLength(1)
  })
  it('requires review for pack quantities, keeps explicit weight units and rejects conflicting units', () => {
    expect(() => parseSupplyText(table(['Назва', 'Кількість упаковок', 'Ціна'], ['Фільтр', 2, 100]))).toThrow('упаков')
    expect(parseSupplyText(table(basic, ['Мастило', '1,5 кг', 100])).products[0].unit).toBe('кг')
    expect(parseSupplyText(table([...basic, 'Од. вим.'], ['Мастило', '1,5 кг', 100, 'KG'])).products[0].unit).toBe('кг')
    expect(() => parseSupplyText(table([...basic, 'Од. вим.'], ['Мастило', '1,5 кг', 100, 'шт']))).toThrow('одиниц')
    expect(parseSupplyText(table(['Назва', 'Кількість, кг', 'Ціна за кг'], ['Мастило', 1.5, 100])).products[0].unit).toBe('кг')
    expect(() => parseSupplyText(table(['Назва', 'Кількість, шт', 'Ціна за кг'], ['Мастило', 2, 100]))).toThrow('одиниц')
  })
  it('checks explicit totals in AI output instead of dropping them', () => {
    expect(() => normalizeSupplyRows([{name:'Фільтр',qty:2,purchase_price_uah:100,line_total:180}])).toThrow('сумою рядка')
    expect(normalizeSupplyRows([{name:'Фільтр',qty:2,purchase_price_uah:100,line_total:200}])).toHaveLength(1)
  })
  it('does not partially import a workbook when a later sheet contains adjustments', () => {
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([basic, ['Фільтр',2,100]]), 'Звичайні')
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[...basic,'Знижка %'],['Ключ',1,200,10]]), 'Знижки')
    expect(() => parseSupplyWorkbook(XLSX.write(book, {type:'array',bookType:'xlsx'}))).toThrow()
  })
  it('preserves all 2000 rows across sheets, including the final quantity and leading-zero SKU', () => {
    const book = XLSX.utils.book_new()
    for (let sheet = 0; sheet < 4; sheet++) {
      const rows = Array.from({length: MAX_SUPPLY_ROWS / 4}, (_,i) => {
        const index = sheet * 500 + i
        return ['Фільтр ' + index, index === 1999 ? 98 : 2, 10, '000' + index]
      })
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[...basic, 'Артикул'],...rows]), 'Лист ' + sheet)
    }
    const parsed = parseSupplyWorkbook(XLSX.write(book, {type:'array',bookType:'xlsx'}))
    expect(parsed.products).toHaveLength(MAX_SUPPLY_ROWS)
    expect(parsed.products.at(-1)).toMatchObject({name:'Фільтр 1999',qty:98,sku:'0001999',purchase_price_uah:10})
  })
})
