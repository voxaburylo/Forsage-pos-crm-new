import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { ReceiptPrint } from './ReceiptPrint'
import type { Sale } from '@/types/sale'
vi.mock('react-dom', () => ({ createPortal: (content: React.ReactNode) => content }))
const sale = {
  sale_number: 'TEST-260915-6583-0024', completed_at: '2026-09-15T14:11:00Z', total: 32500, discount: 0, payment_method: 'transfer',
  sale_items: [
    { product_id: 'test-1', qty: 1, unit_price: 17000, total: 17000, discount: 0, product: { name: 'Ремкомплект вакуумного підсилювача 2101-2107 ASR VB350002 kit', unit: 'шт' } },
    { product_id: 'test-2', qty: 1, unit_price: 15500, total: 15500, discount: 0, product: { name: 'Ганчірка для автомобіля 64×43 Winso в тубі 150500', unit: 'шт' } },
  ],
} as Sale
beforeEach(() => {
  vi.stubGlobal('document', { body: {} })
  vi.stubGlobal('localStorage', { getItem: () => null })
})
afterEach(() => vi.unstubAllGlobals())
it('uses readable black text and separate lines for receipt number and date', () => {
  const html = renderToStaticMarkup(<ReceiptPrint sale={sale} shopName="ТЕСТ — НЕ ЧЕК" sellerName="Перевірка друку" />)
  expect(html).toContain('font-size: 15px')
  expect(html).toContain("font-family: Arial")
  expect(html).toContain('<div>Чек: #TEST-260915-6583-0024</div><div>')
  expect(html).toContain('К-ть / Сума')
  expect(html).not.toContain('Qty')
  if (process.env.FORSAGE_RECEIPT_FIXTURE_OUTPUT) {
    // Static React markup escapes style text, unlike the live DOM outerHTML
    // used by printReceipt. Restore only trusted stylesheet text for this fixture.
    const liveHtml = html.replace(/<style>([\s\S]*?)<\/style>/g, (_match, css: string) => '<style>' + css.replaceAll('&gt;', '>').replaceAll('&#x27;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&') + '</style>')
    writeFileSync(process.env.FORSAGE_RECEIPT_FIXTURE_OUTPUT, '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'+liveHtml+'</body></html>')
  }
})
it('still prepares a receipt when browser storage is unavailable', () => {
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('storage unavailable') } })
  expect(() => renderToStaticMarkup(<ReceiptPrint sale={sale} />)).not.toThrow()
})
