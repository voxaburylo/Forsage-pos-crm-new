import { describe, expect, it } from 'vitest'
import { invoiceProblemQuestion } from './invoiceFormModel'

describe('question to the assistant about a row that does not post', () => {
  it('carries the row identity and the exact reason, and asks not to change anything', () => {
    const text = invoiceProblemQuestion({ product_name: ' Щітка торцева 65мм ', sku: 'WB-1065', barcode: '6939824294323', qty: 5, purchase_price: 5243, product_id: undefined },
      'Рядок 73: Артикул «WB-1065» має видалена картка «Щітка».')
    expect(text).toContain('«Щітка торцева 65мм»')
    expect(text).toContain('артикул WB-1065')
    expect(text).toContain('штрихкод 6939824294323')
    expect(text).toContain('кількість 5')
    expect(text).toContain('закупка 52.43 грн')
    expect(text).toContain('нова картка')
    expect(text).toContain('Програма пише: «Рядок 73: Артикул «WB-1065» має видалена картка «Щітка».»')
    expect(text).toContain('Нічого не змінюй сам')
  })
  it('stays readable for an empty row and is bounded in length', () => {
    const text = invoiceProblemQuestion({ product_name: '', sku: '', barcode: '', qty: 1, purchase_price: 0, product_id: 'p1' }, ' ')
    expect(text).toContain('без назви'); expect(text).toContain('без артикула'); expect(text).toContain('привʼязаний до наявної картки')
    expect(text).toContain('причину не показано')
    expect(invoiceProblemQuestion({ product_name: 'x'.repeat(5000), sku: '', barcode: '', qty: 1, purchase_price: 0 }, 'y').length).toBeLessThanOrEqual(3000)
  })
})
