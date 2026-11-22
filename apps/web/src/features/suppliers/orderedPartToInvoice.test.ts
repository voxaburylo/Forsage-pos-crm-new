import { describe, expect, it } from 'vitest'
import { makeDraftItem, orderedPartToInvoiceItem } from './invoiceFormModel'

describe('a part ordered before becomes a new invoice row (owner request 21.11.2026)', () => {
  it('names the card «name + article» so search finds it, and carries the last prices', () => {
    const row = makeDraftItem(orderedPartToInvoiceItem({ name: 'Колодки передні', sku: 'GDB1330', buy_price: 90000, sell_price: 125000 }))
    expect(row).toMatchObject({ product_name: 'Колодки передні GDB1330', sku: 'GDB1330', qty: 1, purchase_price: 90000, retail_price: 125000, total: 90000, is_new: true })
    expect(row.product_id).toBeUndefined()
  })
  it('does not repeat the article when the name already has it, in any spelling', () => {
    expect(orderedPartToInvoiceItem({ name: 'Фільтр W 712/75 масляний', sku: 'w712-75', buy_price: 0, sell_price: 0 }).product_name).toBe('Фільтр W 712/75 масляний')
    expect(orderedPartToInvoiceItem({ name: 'Свічка', sku: '', buy_price: 0, sell_price: 0 }).product_name).toBe('Свічка')
  })
  it('never proposes a selling price below the purchase price', () => {
    expect(orderedPartToInvoiceItem({ name: 'Ремінь', sku: '6PK1200', buy_price: 50000, sell_price: 40000 }).retail_price).toBe(0)
    expect(orderedPartToInvoiceItem({ name: 'Ремінь', sku: '6PK1200', buy_price: Number.NaN, sell_price: -5 })).toMatchObject({ purchase_price: 0, retail_price: 0, total: 0 })
  })
})
