import { describe, expect, it } from 'vitest'
import { PHONE_INVOICE_INBOX_LIMIT, checkPhoneInvoice, listPhoneInvoices, phoneInvoiceAction, phoneInvoiceGaps, phoneInvoiceTotal, removePhoneInvoice, storePhoneInvoice } from './phoneInvoiceModel'

const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`
function box() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, data }
}
const invoice = (rows: unknown[] = [{ name: ' Фільтр  масляний ', sku: 'W712/75', qty: 2, purchase_price_uah: 120.456, brand_name: 'MANN' }]) =>
  ({ supplier_name: ' Vitol ', invoice_number: '36214', author: 'Олена', rows })

describe('invoice photographed by phone (stage 8, 22.11.2026)', () => {
  it('cleans the rows and keeps unreadable quantity or price empty instead of guessing', () => {
    const checked = checkPhoneInvoice(invoice([
      { name: ' Фільтр  масляний ', sku: 'W712/75', qty: '2', purchase_price_uah: '120,456', brand_name: 'MANN', secret: 'x' },
      { name: 'Свічка', qty: '', purchase_price_uah: null },
    ]))
    expect(checked).toEqual({ supplier_name: 'Vitol', invoice_number: '36214', notes: null, author: 'Олена', rows: [
      { name: 'Фільтр масляний', sku: 'W712/75', brand_name: 'MANN', qty: 2, purchase_price_uah: 120.46 },
      { name: 'Свічка' },
    ] })
    expect(phoneInvoiceGaps(checked.rows)).toBe(1)
    expect(phoneInvoiceTotal(checked.rows)).toBe(24092)
  })
  it('refuses an empty invoice, a row without a name and broken numbers, naming the row', () => {
    expect(() => checkPhoneInvoice({ rows: [] })).toThrow('немає жодного рядка')
    expect(() => checkPhoneInvoice(null)).toThrow('немає жодного рядка')
    expect(() => checkPhoneInvoice(invoice([{ name: 'Ок', qty: 1 }, { name: '  ' }]))).toThrow('Рядок 2: немає назви')
    expect(() => checkPhoneInvoice(invoice([{ name: 'Товар', qty: 0 }]))).toThrow('Рядок 1: перевірте поле «Кількість»')
    expect(() => checkPhoneInvoice(invoice([{ name: 'Товар', qty: 'два' }]))).toThrow('«Кількість»')
    expect(() => checkPhoneInvoice(invoice([{ name: 'Товар', purchase_price_uah: -5 }]))).toThrow('«Закупка»')
    expect(() => checkPhoneInvoice(invoice(Array.from({ length: 301 }, () => ({ name: 'Товар' }))))).toThrow('забагато рядків')
    // Безкоштовний рядок (ціна 0) — це прочитана ціна, а не пропуск.
    expect(checkPhoneInvoice(invoice([{ name: 'Подарунок', qty: 1, purchase_price_uah: 0 }])).rows[0].purchase_price_uah).toBe(0)
  })
  it('stores an invoice in the till inbox once, however many times the command repeats', () => {
    const storage = box()
    expect(storePhoneInvoice(id(1), invoice(), storage, new Date('2026-11-22T08:00:00Z'))).toEqual({ stored: true, rows: 1 })
    expect(storePhoneInvoice(id(1), invoice(), storage)).toEqual({ stored: false, rows: 1 })
    expect(listPhoneInvoices(storage)).toHaveLength(1)
    expect(listPhoneInvoices(storage)[0]).toMatchObject({ operation_id: id(1), received_at: '2026-11-22T08:00:00.000Z', supplier_name: 'Vitol' })
    removePhoneInvoice(id(1), storage)
    expect(listPhoneInvoices(storage)).toEqual([])
  })
  it('refuses a new invoice when the inbox is full and never drops an unprocessed one', () => {
    const storage = box()
    for (let n = 1; n <= PHONE_INVOICE_INBOX_LIMIT; n++) storePhoneInvoice(id(n), invoice(), storage)
    expect(() => storePhoneInvoice(id(99), invoice(), storage)).toThrow('нерозібраних накладних')
    expect(listPhoneInvoices(storage)).toHaveLength(PHONE_INVOICE_INBOX_LIMIT)
    // Пошкоджене сховище не ламає касу.
    storage.setItem('forsage:phone-invoices:v1', '{broken')
    expect(listPhoneInvoices(storage)).toEqual([])
  })
  it('opens through the ordinary recognised-invoice path with the same rows', () => {
    const storage = box()
    storePhoneInvoice(id(1), invoice(), storage)
    const action = phoneInvoiceAction(listPhoneInvoices(storage)[0])
    expect(action).toMatchObject({ id: id(1), tool: 'create_products_bulk',
      payload: { supplier_name: 'Vitol', invoice_number: '36214', notes: 'Накладна з телефона (Олена). Перевірте підсвічені рядки.',
        products: [{ name: 'Фільтр масляний', sku: 'W712/75', qty: 2, purchase_price_uah: 120.46, brand_name: 'MANN' }] } })
  })
})
