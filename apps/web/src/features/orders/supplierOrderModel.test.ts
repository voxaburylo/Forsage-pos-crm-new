import { describe, expect, it } from 'vitest'
import { groupSupplierLines, NO_SUPPLIER_TITLE, supplierOrderText, type SupplierOrderLine } from './supplierOrderModel'
import { arrivalLinks, arrivalMessage, buildOrderLabelDocument, ukrainianPhone } from './orderArrivalNotice'

const line = (over: Partial<SupplierOrderLine>): SupplierOrderLine => ({
  item_id: 'i', order_id: 'o', order_number: 1, name: 'Колодки', sku: 'GDB1550', qty: 1, supplier_id: 's1', supplier_name: 'Технікс',
  customer_name: 'Іван', customer_phone: '0501112233', created_at: '2026-11-23T10:00:00Z', ...over,
})

// 23.11.2026 (план C3): «Замовити в постачальника», повідомлення «прибуло», наклейка.
describe('supplier order screen', () => {
  it('groups by supplier, keeps the order queue, puts lines without a supplier last', () => {
    const groups = groupSupplierLines([
      line({ item_id: 'a', supplier_id: null, supplier_name: null }),
      line({ item_id: 'b', supplier_id: 's2', supplier_name: 'Автокомфорт' }),
      line({ item_id: 'c' }), line({ item_id: 'd' }),
    ])
    expect(groups.map(group => [group.title, group.lines.map(item => item.item_id)])).toEqual([
      ['Автокомфорт', ['b']], ['Технікс', ['c', 'd']], [NO_SUPPLIER_TITLE, ['a']],
    ])
  })

  it('the text for the supplier sums the same article and never carries customer names or phones', () => {
    const text = supplierOrderText({ lines: [line({ qty: 2 }), line({ sku: 'gdb-1550', qty: 1, customer_name: 'Петро' }), line({ sku: null, name: 'Хомут 16-25', qty: 0.5 })] })
    expect(text).toBe('Замовлення від Форсаж:\n1. GDB1550 — Колодки × 3\n2. Хомут 16-25 × 0.5')
    expect(text).not.toMatch(/Іван|Петро|050/)
  })
})

describe('arrival notice for the customer', () => {
  it('accepts only Ukrainian numbers', () => {
    expect(ukrainianPhone('050 111-22-33')).toBe('+380501112233')
    expect(ukrainianPhone('+38 (050) 111 22 33')).toBe('+380501112233')
    expect(ukrainianPhone('501112233')).toBe('+380501112233')
    expect(ukrainianPhone('12345')).toBeNull()
    expect(ukrainianPhone(null)).toBeNull()
  })

  it('writes a full or partial arrival message and opens Viber or SMS with the number', () => {
    expect(arrivalMessage({ order_number: 42, customer_name: 'Іван', complete: true })).toBe('Добрий день, Іван! Ваше замовлення № 42 прибуло в магазин «Форсаж». Можна забирати.')
    expect(arrivalMessage({ order_number: 42, complete: false })).toContain('Частина вашого замовлення № 42')
    const links = arrivalLinks('0501112233', 'Текст')!
    expect(links.viber).toBe('viber://chat?number=%2B380501112233')
    expect(links.sms).toBe('sms:+380501112233?body=%D0%A2%D0%B5%D0%BA%D1%81%D1%82')
    expect(arrivalLinks('123', 'Текст')).toBeNull()
  })

  it('the label shows whose goods these are and escapes the text', () => {
    const doc = buildOrderLabelDocument([
      { order_number: 7, customer_name: '<b>Іван</b>', customer_phone: '0501112233', items: [{ name: 'Колодки', qty: 2 }] },
      { order_number: 8, customer_name: null, customer_phone: null, items: [] },
    ], { width_mm: 58, height_mm: 40 })
    expect(doc).toMatchObject({ widthMm: 58, heightMm: 40, count: 2 })
    expect(doc.html).toContain('Замовлення № 7')
    expect(doc.html).toContain('&lt;b&gt;Іван&lt;/b&gt;')
    expect(doc.html).toContain('Колодки × 2')
    expect(doc.html).toContain('Клієнт без імені')
    expect(() => buildOrderLabelDocument([])).toThrow()
  })
})
