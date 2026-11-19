import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AiInvoiceLineMatch } from './AiInvoiceLineMatch'
import type { LineItem } from './invoiceFormModel'

const card = { id: 'e42x', name: 'Коаксіальна акустика Voice E42X', sku: '93697', barcode: null, brand: 'Voice', unit: 'Пара' }
const row = (unit: string, errors: string[]) => ({
  client_key: 'r1', product_id: 'e42x', product_name: card.name, sku: 'VC-E-42X', barcode: '', unit, qty: 1,
  purchase_price: 117893, retail_price: 153500, total: 117893, is_new: false,
  ai_review: { source: { name: card.name }, choice: 'e42x', result: { name: card.name, source_name: card.name, brand: 'Voice', product_id: 'e42x', status: 'matched', reason: '', candidates: [card], validation_errors: errors } },
}) as unknown as LineItem

describe('invoice row with a different unit than the card', () => {
  it('offers to count in the card unit instead of a dead end', () => {
    const html = renderToStaticMarkup(<AiInvoiceLineMatch item={row('шт.', ['Рядок: одиниця виміру накладної «шт.», у картці «Пара». Перевірте кількість.'])} choose={() => {}} setUnit={() => {}} disabled={false} />)
    expect(html).toContain('Рахувати в одиницях картки «Пара»')
  })
  it('shows no button once the unit matches or without a unit problem', () => {
    expect(renderToStaticMarkup(<AiInvoiceLineMatch item={row('Пара', [])} choose={() => {}} setUnit={() => {}} disabled={false} />)).not.toContain('Рахувати')
    expect(renderToStaticMarkup(<AiInvoiceLineMatch item={row('шт.', ['Відсутня назва товару'])} choose={() => {}} setUnit={() => {}} disabled={false} />)).not.toContain('Рахувати')
  })
})
