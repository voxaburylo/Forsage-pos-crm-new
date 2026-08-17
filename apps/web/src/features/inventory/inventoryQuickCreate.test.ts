import { describe, expect, it } from 'vitest'
import { hasSuspiciousInventorySku, inventoryQuickCreateSeed } from './inventoryQuickCreate'

describe('inventory quick create', () => {
  it('puts a searched product name into the name field, not the article field', () => {
    expect(inventoryQuickCreateSeed('Пружина задня посилена')).toEqual({
      sku: '', barcode: '', name: 'Пружина задня посилена',
    })
  })

  it('keeps scanned barcodes and compact articles as identifiers', () => {
    expect(inventoryQuickCreateSeed('2004475676911')).toEqual({
      sku: '2004475676911', barcode: '2004475676911', name: '',
    })
    expect(inventoryQuickCreateSeed('SUJS000001')).toEqual({
      sku: 'SUJS000001', barcode: '', name: '',
    })
  })

  it('detects a product description pasted into article', () => {
    expect(hasSuspiciousInventorySku('Пружина задня посилена ВАЗ', 'Пружина')).toBe(true)
    expect(hasSuspiciousInventorySku('SUJS000001', 'Тримач Baseus')).toBe(false)
  })
})
