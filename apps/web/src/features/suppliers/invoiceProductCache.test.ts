import { describe, expect, it } from 'vitest'
import { resolveCachedInvoiceProduct } from './invoiceProductCache'

describe('invoice product cache matching', () => {
  const first = { id: 'first', name: 'Перший товар' }
  const second = { id: 'second', name: 'Другий товар' }

  it('uses the single exact key that exists', () => {
    const cache = new Map([['barcode:2003093555486', first]])
    expect(resolveCachedInvoiceProduct(cache, 'ABSENT', '2003093555486', 'Рядок')).toBe(first)
  })

  it('accepts SKU and barcode only when both identify the same product', () => {
    const cache = new Map([
      ['sku:ABC10', first],
      ['barcode:2003093555486', first],
    ])
    expect(resolveCachedInvoiceProduct(cache, 'ABC10', '2003093555486', 'Рядок')).toBe(first)
  })

  it('blocks SKU and barcode that identify different products', () => {
    const cache = new Map([
      ['sku:ABC10', first],
      ['barcode:2003093555486', second],
    ])
    expect(() => resolveCachedInvoiceProduct(cache, 'ABC10', '2003093555486', 'Рулетка'))
      .toThrow('артикул і штрихкод належать різним товарам')
  })
})
