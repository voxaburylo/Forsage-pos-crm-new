import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseSupplyText, parseSupplyWorkbook } from '@/features/ai/aiSupplyImport'
import { buildCheckedInvoiceImport, prepareInvoiceClipboard, rememberInvoiceLayout, restoredInvoiceLayout, supplyRowsForInvoicePreview } from './invoiceImportInput'
import { EMPTY_INVOICE_IMPORT_MAPPING, guessInvoiceImport } from './invoiceFormModel'

const reader = async ({ text }: { text?: string }) => parseSupplyText(text ?? '')
describe('ordinary invoice shares the checked supply reader', () => {
  it('has the same name, quantity and purchase as AI for reordered headers and decimal commas', async () => {
    const text = 'Закупівля\tНазва\tКількість\tАртикул\tЦіна продажу\tКомірка\n125,50\tТовар тест\t1,250\t00012\t190,00\tA-3'
    const parsed = await prepareInvoiceClipboard(text, reader)
    const ai = parseSupplyText(text).products[0]
    expect(parsed.products?.[0]).toMatchObject(ai)
    const rows = supplyRowsForInvoicePreview(parsed.products!)
    const layout = guessInvoiceImport(rows)
    const checked = buildCheckedInvoiceImport(rows, layout.mapping, layout.startRow, layout.headerRow)
    expect(checked.error).toBeUndefined()
    expect(checked.items).toHaveLength(1)
    expect(checked.items[0]).toMatchObject({ product_name: ai.name, sku: '00012', qty: ai.qty, purchase_price: 12550, retail_price: 19000, storage_bin: 'A-3' })
  })
  it('keeps documented headerless legacy input but never defaults bad numbers', async () => {
    expect((await prepareInvoiceClipboard('001\tКлюч\t2\t10,50\t15\tB-2', reader)).products?.[0]).toMatchObject({ name: 'Ключ', sku: '001', qty: 2, purchase_price_uah: 10.5, retail_price_uah: 15, storage_bin: 'B-2' })
    await expect(prepareInvoiceClipboard('001\tКлюч\tпомилка\t10', reader)).rejects.toThrow('кількість')
  })
  it('rejects wrong totals or incomplete rows instead of silently falling back to the loose importer', async () => {
    await expect(prepareInvoiceClipboard('Назва\tКількість\tЦіна\tСума\nКлюч\t2\t10\t50', reader)).rejects.toThrow('не збігається')
    await expect(prepareInvoiceClipboard('Назва\tКількість\tЦіна\nКлюч\t2\t10\n\t1\t5', reader)).rejects.toThrow('рядок')
  })
  it('does not turn foreign source prices into UAH in the ordinary form', async () => {
    await expect(prepareInvoiceClipboard('Назва\tКількість\tЦіна USD\nКлюч\t1\t10', reader)).rejects.toThrow('курс')
  })
  it('reads a known cover plus every product sheet without losing extras', () => {
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Накладна № TEST'], ['Постачальник', 'Тест'], ['Дата', '2026-10-13']]), 'Титул')
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Назва', 'Кількість', 'Ціна', 'Ціна продажу'], ['Ключ', 2, 10, 15]]), 'Товари')
    const parsed = parseSupplyWorkbook(XLSX.write(book, { type: 'array', bookType: 'xlsx' }))
    expect(parsed.products).toEqual([{ name: 'Ключ', qty: 2, purchase_price_uah: 10, retail_price_uah: 15 }])
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Невідомий товар', 1, 20]]), 'Інше')
    expect(parseSupplyWorkbook(XLSX.write(book, { type: 'array', bookType: 'xlsx' })).products).toEqual([])
  })
  it('manual mapping still validates raw quantities, totals, tax and actual product names', () => {
    const rows = [['Артикул', 'Модель', 'Отримано', 'Собівартість', 'Сума'], ['A', 'Total Quartz', '1', '120', '120']]
    const mapping = { ...EMPTY_INVOICE_IMPORT_MAPPING, sku: 0, name: 1, qty: 2, purchase: 3 }
    expect(buildCheckedInvoiceImport(rows, mapping, 1, 0).items[0].product_name).toBe('Total Quartz')
    expect(buildCheckedInvoiceImport([rows[0], ['A', 'Ключ', '??', '120', '120']], mapping, 1, 0).error).toContain('кількість')
    expect(buildCheckedInvoiceImport([rows[0], ['A', 'Ключ', '2', '120', '120']], mapping, 1, 0).error).toContain('не збігається')
    expect(buildCheckedInvoiceImport([['A', 'Модель', 'Отримано', 'Ціна без ПДВ'], ['A', 'Ключ', 1, 120]], mapping, 1, 0).error).toContain('кінцеву закупівельну ціну')
  })
  it('reuses a confirmed mapping only with an identical header, never for a reordered or headerless file', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } }
    const rows = [['Артикул', 'Модель', 'Отримано', 'Собівартість'], ['A', 'Ключ', 1, 10]]
    const mapping = { ...EMPTY_INVOICE_IMPORT_MAPPING, sku: 0, name: 1, qty: 2, purchase: 3 }
    rememberInvoiceLayout(rows, 0, mapping, storage)
    expect(restoredInvoiceLayout([rows[0], ['B', 'Фільтр', 4, 20]], 0, storage)).toEqual(mapping)
    expect(restoredInvoiceLayout([['Модель', 'Артикул', 'Отримано', 'Собівартість']], 0, storage)).toBeNull()
    expect(restoredInvoiceLayout(rows, null, storage)).toBeNull()
  })
  it('manual Excel mapping retains numeric precision and formatted identifier zeroes', () => {
    const rows = [['Артикул', 'Модель', 'Отримано', 'Собівартість'], ['00012', 'Ключ', '1', '10']]
    const raw = [rows[0], [12, 'Ключ', 1.25, 10.49]]
    const mapping = { ...EMPTY_INVOICE_IMPORT_MAPPING, sku: 0, name: 1, qty: 2, purchase: 3 }
    expect(buildCheckedInvoiceImport(rows, mapping, 1, 0, raw).items[0]).toMatchObject({ sku: '00012', qty: 1.25, purchase_price: 1049 })
  })
})
