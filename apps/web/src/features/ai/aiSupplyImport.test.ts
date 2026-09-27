import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { MAX_SUPPLY_ROWS, MAX_SUPPLY_TEXT, convertSupplyPrices, readSupplyExchangeRate, normalizeSupplyRows, parseSupplyText, parseSupplyWorkbook, supplyImportAction } from './aiSupplyImport'
import { readFileSync } from 'node:fs'

const header = ['Назва', 'Артикул', 'Штрихкод', 'Кількість', 'Ціна закупівлі', 'Папка']
const row = ['Круг 100мм', '0001', '2000177521924', '98', '10,00', 'Інструмент']
function workbook(sheets: unknown[][][], type: XLSX.BookType = 'xlsx') {
  const book = XLSX.utils.book_new()
  sheets.forEach((rows, i) => XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), `Лист ${i+1}`))
  return XLSX.write(book, { type: 'array', bookType: type }) as ArrayBuffer
}
const tsv = (rows: unknown[][]) => rows.map(row => row.join('\t')).join('\r\n')
describe('AI supply input: exact quantities and a single unposted draft', () => {
  it('validates AI quantities and prices before offering confirmation', () => {
    expect(() => normalizeSupplyRows([{name: 'Круг', purchase_price_uah: 10}])).toThrow('кількість')
    expect(() => normalizeSupplyRows([{name: 'Круг', qty: 98}])).toThrow('ціну')
    expect(normalizeSupplyRows([{name: 'Круг', qty_on_hand: 98, purchase_price_uah: 10, sku: '', brand_name: 'Тест'}])).toEqual([{name:'Круг', qty:98, purchase_price_uah:10, brand:'Тест'}])
  })
  it('preserves 98, leading zero article and barcode, folder; does not invent stock or sale price', () => {
    const parsed = parseSupplyText(tsv([header, row]))
    expect(parsed.products).toEqual([{ name: 'Круг 100мм', sku: '0001', barcode: '2000177521924', qty: 98, purchase_price_uah: 10, category_name: 'Інструмент' }])
    const action = supplyImportAction(parsed.products, 'Буфер')
    expect(action.tool).toBe('create_supply_invoice_bulk')
    expect(action.payload.products[0]).not.toHaveProperty('qty_on_hand')
    expect(action.payload.products[0]).not.toHaveProperty('retail_price_uah')
  })
  it.each(['xlsx', 'xls'] as const)('reads %s without losing identifiers', type => {
    expect(parseSupplyWorkbook(workbook([ [header, row] ], type)).products).toEqual(parseSupplyText(tsv([header, row])).products)
  })
  it('uses numeric cell values, not rounded display, and formatted text for codes', () => {
    const book = XLSX.utils.book_new(), sheet = XLSX.utils.aoa_to_sheet([header, ['Круг', 12, 123, 1.25, 1000, '']])
    sheet.B2.z = '0000'; sheet.C2.z = '000000'; sheet.D2.z = '0'; sheet.E2.z = '#,##0.00'
    XLSX.utils.book_append_sheet(book, sheet, 'Цифри')
    const [p] = parseSupplyWorkbook(XLSX.write(book, { type: 'array', bookType: 'xlsx' })).products
    expect(p).toMatchObject({ sku: '0012', barcode: '000123', qty: 1.25, purchase_price_uah: 1000 })
  })
  it('handles quoted CSV with semicolon and newline inside name', () => {
    const [p] = parseSupplyText('Наименование;Количество;Цена;Артикул\n"Мастило; 4л\nНове";2;120,50;001').products
    expect(p).toMatchObject({ name: 'Мастило; 4л\nНове', qty: 2, purchase_price_uah: 120.5, sku: '001' })
  })
  it.each(['1 234,50 грн', '1,234.50', '1.234,50', '1234.50 ₴'])('reads price %s', price => {
    expect(parseSupplyText(tsv([header, [...row.slice(0, 4), price]])).products[0].purchase_price_uah).toBe(1234.5)
  })
  it('does not turn 1,250 received units into 1250', () => {
    expect(parseSupplyText('Назва\tКількість\tЦіна\nОлива\t1,250\t120').products[0].qty).toBe(1.25)
  })
  it.each(['', 'не знаю', '-3', '0', '1.0001', '98 шт 2', '1e3'])('rejects quantity %s rather than defaulting to 1', qty => {
    expect(() => parseSupplyText(tsv([header, [row[0], '', '', qty, '10']]))).toThrow('кількість')
  })
  it.each(['', 'невідомо', '-10', '120,5,0', '1.001', '10*2'])('rejects price %s rather than defaulting to 0', price => {
    expect(() => parseSupplyText(tsv([header, [...row.slice(0, 4), price]]))).toThrow('ціну')
  })
  it('permits an explicitly specified zero price', () => {
    expect(parseSupplyText('Назва\tКількість\tЦіна\nДарунок\t1\t0').products[0].purchase_price_uah).toBe(0)
  })
  it('does not manufacture article or barcode', () => {
    expect(parseSupplyText('Назва\tКількість\tЦіна\nНовий\t2\t10').products[0]).toEqual({ name: 'Новий', qty: 2, purchase_price_uah: 10 })
  })
  it('does not use totals or retail prices as purchase price', () => {
    expect(parseSupplyText('Назва\tКількість\tСума\tЦіна продажу\nНовий\t2\t100\t80').products).toEqual([])
    expect(parseSupplyText('Назва\tЗалишок\tЦіна\nНовий\t2\t100').products).toEqual([])
  })
  it('rejects ambiguous price/quantity columns rather than selecting the first silently', () => {
    expect(() => parseSupplyText('Назва\tКількість упаковок\tКількість шт\tЦіна\nНовий\t1\t10\t100')).toThrow('кілька колонок')
    expect(() => parseSupplyText('Назва\tКількість\tЦіна без ПДВ\tЦіна з ПДВ\nНовий\t1\t100\t120')).toThrow('кілька колонок')
  })
  it('skips explicit totals and blank rows; ambiguous unnamed rows require full AI review', () => {
    expect(parseSupplyText(tsv([header, row, [], ['Разом:', '', '', '', '', '', '980']])).products).toHaveLength(1)
    const source = tsv([header, row, ['', 'AB', '', '4', '50']])
    const parsed = parseSupplyText(source)
    expect(parsed.products).toEqual([])
    expect(parsed.text).toBe(source)
    expect(parsed.reviewReason).toContain('рядок 3')
  })
  it('reads printed TDSheet footers with summary and amount in words, without losing later goods', () => {
    const parsed = parseSupplyText(tsv([header, row, ['Разом:', '', '', '', '', '', '980'],
      ['Всього найменувань 1, на суму 980,00 USD.'], ['Дев’ятсот вісімдесят доларів 00 центів'], row]))
    expect(parsed.products).toHaveLength(2)
    expect(parsed.sourceCurrency).toBe('USD')
    expect(parsed.reviewReason).toBeUndefined()
  })
  it('keeps Total-branded products and does not treat a product with identifiers as a footer', () => {
    const parsed = parseSupplyText(tsv([header, row, ['Total Quartz 9000', 'TOTAL-1', '', '2', '100']]))
    expect(parsed.products).toHaveLength(2)
  })
  it('detects foreign currency and requires a positive explicit exchange rate', () => {
    const parsed = parseSupplyText(tsv([header, ['Кабель', '001', '', '2', '1,19'], ['Всього на суму 2,38 USD.']]))
    expect(parsed.sourceCurrency).toBe('USD')
    for (const bad of ['', '0', '-4', 'невідомо', 'Infinity']) expect(() => readSupplyExchangeRate(bad)).toThrow('курс')
    expect(convertSupplyPrices(parsed.products, readSupplyExchangeRate('42,50'))[0].purchase_price_uah).toBe(50.58)
    expect(parsed.products[0].purchase_price_uah).toBe(1.19)
    expect(convertSupplyPrices([{name:'Округлення',qty:1,purchase_price_uah:0.01}],1.5)[0].purchase_price_uah).toBe(0.02)
  })
  it('rejects mixed currencies instead of using the wrong rate for one sheet', () => {
    expect(() => parseSupplyText(tsv([header, row, ['Всього на суму 10 USD.'], ['Всього на суму 10 EUR.']]))).toThrow('кілька валют')
  })
  it.runIf(!!process.env.FORSAGE_AI_INVOICE_FIXTURE)('reconciles the owner-provided TDSheet: 31 positions / USD 374.32', () => {
    const file = readFileSync(process.env.FORSAGE_AI_INVOICE_FIXTURE!)
    const parsed = parseSupplyWorkbook(file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength))
    expect(parsed.products).toHaveLength(31)
    expect(parsed.sourceCurrency).toBe('USD')
    expect(parsed.reviewReason).toBeUndefined()
    expect(parsed.products.reduce((sum,p)=>sum + Math.round(p.purchase_price_uah*100)*p.qty,0)).toBe(37432)
    expect(parsed.products.every(p=>p.sku?.startsWith('000'))).toBe(true)
  })
  it('combines all recognized sheets and keeps more than 500 rows in ONE action', () => {
    const parsed = parseSupplyWorkbook(workbook([[header, ...Array.from({length: 501}, () => row)], [header, row]]))
    expect(parsed.products).toHaveLength(502)
    expect(supplyImportAction(parsed.products, 'Excel').payload.products).toHaveLength(502)
  })
  it('does not silently drop an unknown sheet; sends the whole source to AI review', () => {
    const parsed = parseSupplyWorkbook(workbook([[header, row], [['Додаткові дані'], ['Фільтр', 2, 120]]]))
    expect(parsed.products).toEqual([])
    expect(parsed.text).toContain('Фільтр')
    expect(parsed.text).toContain('Круг 100мм')
  })
  it('keeps free text for AI and rejects empty and oversized input', () => {
    expect(parseSupplyText('Два фільтри по 120 гривень').products).toEqual([])
    expect(() => parseSupplyText('')).toThrow('порожня')
    expect(() => parseSupplyText('a'.repeat(MAX_SUPPLY_TEXT + 1))).toThrow('завеликий')
    expect(() => parseSupplyText(tsv([header, ...Array.from({length: MAX_SUPPLY_ROWS + 1}, () => row)]))).toThrow('2000')
  })
})
