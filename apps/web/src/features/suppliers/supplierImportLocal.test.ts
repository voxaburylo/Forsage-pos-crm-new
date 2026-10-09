import { describe, expect, it } from 'vitest'
import {
  buildSupplierImportRows,
  buildSupplierProductMatchIndex,
  guessSupplierImportMapping,
  matchSupplierImportRow,
  normalizeSupplierBarcode,
  normalizeSupplierProductName,
} from './supplierImportLocal'

describe('supplier Excel import mapping', () => {
  it('detects a header row and keeps exact barcode text', () => {
    const raw = [
      ['Прайс постачальника'],
      ['Артикул', 'Штрих-код', 'Назва товару', 'Кількість', 'Ціна закупки'],
      ['ab-10', '2003093555486', 'Пускові дроти', '2', '75,50'],
    ]
    const guessed = guessSupplierImportMapping(raw)
    const result = buildSupplierImportRows(raw, guessed.mapping, guessed.startRow)

    expect(guessed).toMatchObject({ startRow: 2, headerRow: 1 })
    expect(result.rows).toEqual([{
      source_row: 3,
      sku: 'ab-10',
      barcode: '2003093555486',
      brand: '',
      name: 'Пускові дроти',
      qty: '2',
      price_kopecks: 7550,
    }])
  })

  it('does not import rows without a name or valid purchase price', () => {
    const result = buildSupplierImportRows(
      [['A-1', '', '10'], ['A-2', 'Товар', 'не ціна']],
      { sku: 0, barcode: null, brand: null, name: 1, qty: null, price: 2 },
      0,
    )
    expect(result.rows).toHaveLength(0)
    expect(result.errors.map((error) => error.row)).toEqual([1, 2])
  })
})

describe('supplier numeric import safety', () => {
  const mapping = { sku: 0, name: 1, qty: 2, price: 3, barcode: null, brand: null }
  it.each([
    ['2oops', '12'], ['-1', '12'], ['0.0001', '12'], ['1 2', '12'],
    ['1e3', '12'], ['1', '12oops'], ['1', '12.345'], ['1', '21 474 836,48'],
  ])('reports an invalid quantity/price (%s, %s) instead of inventing a number', (qty, price) => {
    const result = buildSupplierImportRows([['CODE', 'Товар', qty, price]], mapping, 0)
    expect(result.rows).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].row).toBe(1)
  })
  it('keeps comma thousandths and explicit zero, including grouped prices', () => {
    const result = buildSupplierImportRows([
      ['A', 'Перший', '0,125', '1 234,56'],
      ['B', 'Другий', '1 234,125', '₴ 1,234.56'],
      ['C', 'Третій', 0, 0],
    ], mapping, 0)
    expect(result.errors).toEqual([])
    expect(result.rows.map(row => [row.qty, row.price_kopecks])).toEqual([
      ['0.125', 123456], ['1234.125', 123456], ['0', 0],
    ])
  })
})

describe('supplier product exact matching', () => {
  const first = { id: 'p1', sku: 'ABC-10', barcode: '200 309-3555486', name: 'Рулетка 5м Greener' }
  const second = { id: 'p2', sku: 'XYZ-20', barcode: '222', name: 'Рулетка 7.5м Greener' }
  const index = buildSupplierProductMatchIndex([first, second])

  it('uses exact barcode before exact SKU or name', () => {
    const match = matchSupplierImportRow({ sku: '', barcode: '2003093555486', name: 'Інша назва' }, index)
    expect(match).toMatchObject({ product: first, kind: 'barcode', error: null })
  })

  it('uses an exact normalized SKU when there is no barcode match', () => {
    const match = matchSupplierImportRow({ sku: ' abc-10 ', barcode: '', name: 'Інша назва' }, index)
    expect(match).toMatchObject({ product: first, kind: 'sku', error: null })
  })

  it('accepts only the full normalized name and never a partial name', () => {
    expect(normalizeSupplierProductName('  Рулетка 5м, Greener  ')).toBe('рулетка 5м greener')
    expect(matchSupplierImportRow({ sku: '', barcode: '', name: 'Рулетка 5м, Greener' }, index))
      .toMatchObject({ product: first, kind: 'name', error: null })
    expect(matchSupplierImportRow({ sku: '', barcode: '', name: 'Рулетка Greener' }, index).product).toBeNull()
  })

  it('blocks a row whose exact barcode and SKU point to different products', () => {
    const match = matchSupplierImportRow({ sku: second.sku, barcode: first.barcode, name: 'Будь-яка назва' }, index)
    expect(match.product).toBeNull()
    expect(match.error).toContain('належать різним товарам')
  })

  it('normalizes formatted/scientific spreadsheet barcode suffixes safely', () => {
    expect(normalizeSupplierBarcode(' 200 309-3555486.0 ')).toBe('2003093555486')
    expect(normalizeSupplierBarcode('2.003093555486e+12')).toBe('2003093555486')
  })
})
