import { describe, expect, it } from 'vitest'
import { createdProductReference, productEditorPayload, productHasNegativeMargin, productMoneyInput, suggestedRetailText } from './productFormModel'
import type { ProductFormData } from '@/types/product'

const form = (): ProductFormData => ({
  sku: ' SKU ', name: ' Фільтр ', barcode: ' 001234 ', brand_id: 'brand', category_id: 'category',
  unit: 'шт', purchase_price: '1 000,50', retail_price: '1 250,50', qty_on_hand: '98',
  reorder_point: '2,125', notes: 'Notes', is_active: true, storage_bin: 'B2', is_favorite: false,
  specs: { volume: '4л' }, core_deposit_amount: '10,01', cross_numbers: 'W 67/1', photo_url: 'file:///test.jpg',
})

describe('product editor payload', () => {
  it('normalizes complete values, keeps barcode leading zeros and never sends observed stock', () => {
    const input = form(), snapshot = structuredClone(input)
    const output = productEditorPayload(input, true)
    expect(output).toEqual({
      ...input, sku: 'SKU', name: 'Фільтр', barcode: '001234', purchase_price: '1000.50',
      retail_price: '1250.50', reorder_point: '2.125', core_deposit_amount: '10.01',
      qty_on_hand: undefined,
    })
    expect(output).not.toHaveProperty('qty_on_hand')
    expect(input).toEqual(snapshot)
  })
  it('omits hidden purchase price, even if it contains invalid stale text', () => {
    const output = productEditorPayload({ ...form(), purchase_price: 'hidden-price' }, false)
    expect(output).not.toHaveProperty('purchase_price')
    expect(output).not.toHaveProperty('qty_on_hand')
  })
  it.each(['', ' ', '1e3', '12грн', '1.234', '-1', '99999999999999'])('rejects invalid retail price %s', value => {
    expect(() => productEditorPayload({ ...form(), retail_price: value }, true)).toThrow()
  })
  it.each(['-1', '2шт', '1.2345', 'Infinity', '1e3', '9999999999999999999'])('rejects invalid reorder point %s', value => {
    expect(() => productEditorPayload({ ...form(), reorder_point: value }, true)).toThrow('залишок')
  })
  it('permits zero prices and blank optional prices/threshold, but not an absent selling price', () => {
    const output = productEditorPayload({ ...form(), retail_price: '0', purchase_price: '', reorder_point: '', core_deposit_amount: '' }, true)
    expect(output).toMatchObject({ retail_price: '0.00', purchase_price: '0.00', core_deposit_amount: '0.00', reorder_point: '0' })
  })
  it.each([{ sku: '  ' }, { name: ' x ' }, { purchase_price: '12bad' }, { core_deposit_amount: '10.001' }])('validates all editable fields before writing: %j', invalid => {
    expect(() => productEditorPayload({ ...form(), ...invalid }, true)).toThrow()
  })
  it('uses the same price parser for markup as for saving', () => {
    expect(productMoneyInput('1 250,50', 'Ціна')).toBe(125050)
    expect(suggestedRetailText(125050)).toBe('1250.50')
    expect(suggestedRetailText(0)).toBe('0.00')
  })
  it.each([
    ['1 000,50', '999,99', true],
    ['999,99', '1 000,50', false],
    ['100,51', '100.50', true],
    ['100,50', '100.50', false],
    ['', '100', false],
    ['120 bad', '100', false],
  ])('compares complete prices in margin warning: %s / %s', (purchase, retail, expected) => {
    expect(productHasNegativeMargin(purchase, retail)).toBe(expected)
  })
  it.each([NaN, Infinity, -1, 0.5, '120', undefined, 2147483648])('rejects invalid suggested price %s', value => {
    expect(() => suggestedRetailText(value)).toThrow('ціна')
  })
})

describe('reference creation acknowledgement', () => {
  it('accepts supported direct and wrapped responses', () => {
    const reference = { id: 'id', name: 'Фільтри' }
    expect(createdProductReference(reference)).toEqual(reference)
    expect(createdProductReference({ data: reference })).toEqual(reference)
  })
  it.each([null, undefined, {}, { data: null }, { id: '', name: 'x' }, { id: 12, name: 'x' }, { id: 'id', name: '' }])('rejects an incomplete acknowledgement %j', response => {
    expect(() => createdProductReference(response)).toThrow('підтвердити')
  })
})
