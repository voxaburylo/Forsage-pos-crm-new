import { describe, expect, it } from 'vitest'
import { findInvoiceIdentifierConflicts, receivingErrorText } from './invoiceIdentifierConflicts'

const row = (product_name: string, sku: string, barcode = '', product_id?: string) => ({ product_name, sku, barcode, product_id })

describe('invoice identifier conflicts before posting', () => {
  it('lists every row that shares a barcode or SKU with different goods', () => {
    const conflicts = findInvoiceIdentifierConflicts([
      row('Щітка 400', 'WB-400', '6939824294323'),
      row('Щітка 450', 'WB-450', '6939 8242 94323'),
      row('Щітка 500', 'wb-400'),
    ])
    expect(conflicts.map(c => [c.index, c.other, c.field])).toEqual([[1, 0, 'barcode'], [2, 0, 'sku']])
    expect(conflicts[0].message).toContain('Рядок 2: штрихкод «6939 8242 94323» вже є в рядку 1')
  })
  it('allows the same goods on two rows and empty identifiers', () => {
    expect(findInvoiceIdentifierConflicts([row('Щітка 400', 'WB-400', '1'), row('щітка  400', 'WB-400', '1')])).toEqual([])
    expect(findInvoiceIdentifierConflicts([row('А', 'X', '', 'p1'), row('Б', 'X', '', 'p1')])).toEqual([])
    expect(findInvoiceIdentifierConflicts([row('А', ''), row('Б', '')])).toEqual([])
  })
})

describe('receiving error text for the cashier', () => {
  it('drops the log codes but keeps the row and text', () => {
    expect(receivingErrorText("Error invoking remote method 'x': Error: RECEIVING_LINE:3:card-changed: Рядок 4: Картка змінилася"))
      .toEqual({ line: 3, text: 'Рядок 4: Картка змінилася' })
    expect(receivingErrorText('RECEIVING_LINE:0: Картка змінилася — перевірте рядок')).toEqual({ line: 0, text: 'Картка змінилася — перевірте рядок' })
    expect(receivingErrorText('RECEIVING_STEP:posting: База зайнята')).toEqual({ line: null, text: 'База зайнята' })
  })
})

// 24.11.2026 (накладна власника: звичайний і вугільний фільтр салона лягли в одну картку).
describe('two rows bound to one card with different codes', () => {
  it('names both rows and both articles instead of a vague refusal at posting', () => {
    const conflicts = findInvoiceIdentifierConflicts([
      row('Фильтр салона Амулет Könner', 'KCF-8113', '2100000000494', 'p1'),
      row('Фильтр салона угольный Амулет Könner', 'KCF-8113-C', '', 'p1'),
    ])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ index: 1, other: 0, field: 'sku', value: 'KCF-8113-C' })
    expect(conflicts[0].message).toContain('Рядки 1 і 2 привʼязані до однієї картки, але артикули в них різні: «KCF-8113» і «KCF-8113-C»')
  })
  it('the same card twice with the same or an empty code stays allowed; different barcodes are caught too', () => {
    expect(findInvoiceIdentifierConflicts([row('А', 'X-1', '', 'p1'), row('А', 'x-1', '', 'p1'), row('А', '', '', 'p1')])).toEqual([])
    expect(findInvoiceIdentifierConflicts([row('А', '', '111', 'p1'), row('А', '', '222', 'p1')])[0]).toMatchObject({ index: 1, field: 'barcode' })
  })
})
