import { describe, expect, it } from 'vitest'
import { bindInvoiceCandidate } from './aiInvoiceMatching'

// 25.11.2026: накладна 11870 (фото, «Покрова») знизила ціни наявних карток за сіткою: зарядний 1430→1185,
// скребок 150→145, антидощ 165→160… Правило власника: ціни автоматично не знижувати.
describe('an invoice never lowers the sale price of an existing card by itself', () => {
  const item = { client_key: 'k', product_name: 'Зарядний', sku: 'Z', barcode: '', unit: 'шт', qty: 1, purchase_price: 91120, retail_price: 118500, total: 91120, category_id: null, is_new: true } as any
  const card = { id: 'p', name: 'Зарядний пристрій', sku: 'Z', barcode: '', retail_price: 143000, category_id: null } as any
  it('keeps the higher card price', () => expect(bindInvoiceCandidate(item, card).retail_price).toBe(143000))
  it('raises it when the grid price is higher', () => expect(bindInvoiceCandidate({ ...item, retail_price: 150000 }, card).retail_price).toBe(150000))
  it('takes the card price when the invoice has none', () => expect(bindInvoiceCandidate({ ...item, retail_price: 0 }, card).retail_price).toBe(143000))
})
