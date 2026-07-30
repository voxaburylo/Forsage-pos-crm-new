import { describe, expect, it, vi } from 'vitest'
import { resolveActiveLinkedInvoiceProduct } from './invoiceProductLink'

describe('invoice linked product safety', () => {
  it('keeps an active linked product', async () => {
    const product = { id: 'active-product' }
    await expect(resolveActiveLinkedInvoiceProduct(product.id, async () => product))
      .resolves.toBe(product)
  })

  it('treats a definitely deleted linked product as missing', async () => {
    const load = vi.fn().mockRejectedValue({ status: 404, code: 'PRODUCT_NOT_FOUND' })
    await expect(resolveActiveLinkedInvoiceProduct('deleted-product', load))
      .resolves.toBeNull()
  })

  it('does not create a duplicate when the server is merely unavailable', async () => {
    const unavailable = new Error('Сервер не відповідає')
    await expect(resolveActiveLinkedInvoiceProduct('product', async () => {
      throw unavailable
    })).rejects.toBe(unavailable)
  })
})
