import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { recognizedInvoiceRows, webInvoiceFromForm, type WebInvoiceRow } from './webInvoicePhoto'

const row = (over: Partial<WebInvoiceRow> = {}): WebInvoiceRow => ({ key: 1, name: 'Фільтр масляний', sku: 'W712/75', qty: '2', price: '120,5', extra: {}, ...over })
const form = { supplier: 'Vitol', number: '36214', notes: '' }

describe('invoice from the phone: recognised rows and the form (stage 8, 22.11.2026)', () => {
  it('turns recognised rows into form rows without inventing quantity or price', () => {
    const { rows, skipped } = recognizedInvoiceRows([
      { name: ' Фільтр  масляний ', sku: 'W712/75', brand_name: 'MANN', qty: 2, purchase_price_uah: 120.5, unit: 'шт', source_name: 'Фильтр масл.', line_total: 241 },
      { name: 'Свічка', article: 'BKR6E' },
      { sku: 'БЕЗ-НАЗВИ', qty: 1 },
      'сміття',
    ], 5)
    expect(skipped).toBe(2)
    expect(rows).toEqual([
      { key: 5, name: 'Фільтр масляний', sku: 'W712/75', qty: '2', price: '120.5', extra: { source_name: 'Фильтр масл.', brand_name: 'MANN', unit: 'шт' } },
      { key: 6, name: 'Свічка', sku: 'BKR6E', qty: '', price: '', extra: {} },
    ])
    expect(() => recognizedInvoiceRows(null)).toThrow('не повернув рядки')
  })
  it('builds the invoice for the till, skips blank rows and names the broken one', () => {
    const invoice = webInvoiceFromForm(form, [row({ extra: { brand_name: 'MANN', source_name: 'Фільтр масляний' } }), row({ key: 2, name: '', sku: '', qty: '', price: '' }), row({ key: 3, name: 'Свічка', sku: '', qty: '', price: '' })], 'Олена')
    expect(invoice).toEqual({ supplier_name: 'Vitol', invoice_number: '36214', notes: null, author: 'Олена', rows: [
      { name: 'Фільтр масляний', source_name: 'Фільтр масляний', sku: 'W712/75', brand_name: 'MANN', qty: 2, purchase_price_uah: 120.5 },
      { name: 'Свічка' },
    ] })
    expect(() => webInvoiceFromForm(form, [row(), row({ key: 2, qty: 'дві' })], '')).toThrow('Рядок 2: перевірте поле «Кількість»')
    expect(() => webInvoiceFromForm(form, [row({ name: ' ', sku: 'X1' })], '')).toThrow('Рядок 1: немає назви')
    expect(() => webInvoiceFromForm(form, [], '')).toThrow('немає жодного рядка')
  })
  it('drops the original printed name once a person has renamed the row', () => {
    const invoice = webInvoiceFromForm(form, [row({ name: 'Фільтр масляний MANN', extra: { source_name: 'Фильтр масл.' } })], '')
    expect(invoice.rows[0]).toEqual({ name: 'Фільтр масляний MANN', sku: 'W712/75', qty: 2, purchase_price_uah: 120.5 })
  })
  it('the web screen only recognises and hands rows to the till; it never posts or touches stock', () => {
    const page = readFileSync(new URL('./WebInvoicePhotoPage.tsx', import.meta.url), 'utf8')
    const model = readFileSync(new URL('./webInvoicePhoto.ts', import.meta.url), 'utf8')
    expect(page).toContain("command: 'invoice.draft'")
    for (const source of [page, model]) for (const banned of ['supplierApi', 'desktopBridge', 'postInvoice', 'apply-action']) expect(source).not.toContain(banned)
    const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
    const route = app.split('\n').filter(line => line.includes('<Route path="/invoice-photo"'))
    expect(route).toHaveLength(1)
    // На касі цей адрес веде у звичайний список накладних; повна форма приходу у вебі лишається закритою.
    expect(route[0]).toContain('<TillOrView till={<Navigate to="/suppliers/invoices" replace />} view={<WebInvoicePhotoPage />} />')
  })
})
