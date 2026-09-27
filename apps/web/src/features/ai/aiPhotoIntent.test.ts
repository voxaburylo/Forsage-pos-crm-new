import { describe, expect, it } from 'vitest'
import { isOrderPhotoRequest, isSupplyRecognitionRequest, SUPPLY_PHOTO_INSTRUCTION } from './aiPhotoIntent'
import { normalizeSupplyRows, supplyImportAction } from './aiSupplyImport'

describe('photo receiving is independent from the optional mode switch', () => {
  it.each(['', 'Розбери', 'Розбери накладну повністю', 'це накладна на замовлення', 'создай товары по фото'])('routes invoice photo with comment %j to receiving', message => {
    expect(isSupplyRecognitionRequest({ invoiceMode: false, hasTable: false, hasImages: true, message })).toBe(true)
  })
  it.each(['Створи замовлення', 'Это заказ из тетради', 'Фото VIN коду', 'замовлення клієнта з зошита'])('preserves explicit customer order %j', message => {
    expect(isOrderPhotoRequest(message)).toBe(true)
    expect(isSupplyRecognitionRequest({ invoiceMode: false, hasTable: false, hasImages: true, message })).toBe(false)
  })
  it('does not change text-only chat and keeps dedicated invoice/table input receiving', () => {
    expect(isSupplyRecognitionRequest({ invoiceMode: false, hasTable: false, hasImages: false, message: 'Привіт' })).toBe(false)
    for (const kind of ['invoiceMode', 'hasTable'] as const) {
      expect(isSupplyRecognitionRequest({ invoiceMode: false, hasTable: false, hasImages: true, message: 'для замовлення', [kind]: true })).toBe(true)
    }
  })
  it('instructs row numbers, purchasing prices and brands even with a user comment', () => {
    expect(SUPPLY_PHOTO_INSTRUCTION).toContain('НЕ артикули')
    expect(SUPPLY_PHOTO_INSTRUCTION).toContain('НЕ роздрібна')
    expect(SUPPLY_PHOTO_INSTRUCTION).toContain('brand_name')
  })
  it('does not repurpose the reported retail-only catalog proposal as purchasing data', () => {
    expect(() => normalizeSupplyRows([{ name: 'Автошина', sku: '1', qty_on_hand: 4, retail_price_uah: 1455 }])).toThrow(/закупівельну ціну/)
  })
  it('turns the six recognized lines into one reviewable invoice, not catalog writes', () => {
    const rows = normalizeSupplyRows([1455,14,18,1860,1782,1750].map((price,index) => ({ name: `Товар ${index+1}`, sku: '', qty: [4,20,20,4,2,1][index], purchase_price_uah: price })))
    const action = supplyImportAction(rows, 'Фото накладної')
    expect(action.tool).toBe('create_supply_invoice_bulk')
    expect(action.count).toBe(6)
    expect(rows.reduce((sum,row) => sum + Math.round(row.qty * row.purchase_price_uah * 100),0)).toBe(1_921_400)
    expect(rows.every(row => !row.sku && !('retail_price_uah' in row))).toBe(true)
  })
})
