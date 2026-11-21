import { describe, expect, it } from 'vitest'
import { cartScreenshotRows } from './orderCartScreenshot'

/** Етап 2 плану: рядки зі скриншота кошика постачальника (зразок власника, 21.11.2026). */
describe('supplier cart screenshot → order items', () => {
  it('keeps brand, article, quantity and purchase price; never fills the selling price', () => {
    const { rows, skipped } = cartScreenshotRows([
      { name: 'Фільтр масляний', brand_name: 'MANN', sku: 'MF HU719/7X', qty: 1, purchase_price_uah: 224.39 },
      { name: 'Фільтр паливний', brand_name: 'KS', sku: 'KS 50013967', qty: 2, purchase_price_uah: 1182.58 },
      { name: 'Ремінь поліклиновий GATES', brand_name: 'GATES', sku: 'GT 6PK1270', qty: 3, purchase_price_uah: 557.16 },
    ])
    expect(skipped).toBe(0)
    expect(rows).toEqual([
      { name: 'Фільтр масляний MANN', sku: 'MF HU719/7X', qty: '1', buy_price: '224.39' },
      { name: 'Фільтр паливний KS', sku: 'KS 50013967', qty: '2', buy_price: '1182.58' },
      { name: 'Ремінь поліклиновий GATES', sku: 'GT 6PK1270', qty: '3', buy_price: '557.16' },
    ])
    expect(rows.every(row => !('sell_price' in row))).toBe(true)
  })

  it('does not invent values: missing quantity is 1, unreadable price stays 0, nameless rows are counted', () => {
    const { rows, skipped } = cartScreenshotRows([{ name: 'Датчик температури', sku: 'VE WS2607' }, { sku: 'X-1', qty: 4 }, { name: 'Прокладка', qty: -2, purchase_price_uah: 'abc' }, null])
    expect(skipped).toBe(2)
    expect(rows).toEqual([{ name: 'Датчик температури', sku: 'VE WS2607', qty: '1', buy_price: '0' }, { name: 'Прокладка', sku: '', qty: '1', buy_price: '0' }])
  })

  it('refuses a reply that is not a list or is suspiciously long', () => {
    expect(() => cartScreenshotRows(undefined)).toThrow('не повернув список')
    expect(() => cartScreenshotRows(new Array(201).fill({ name: 'x' }))).toThrow('забагато')
  })
})
