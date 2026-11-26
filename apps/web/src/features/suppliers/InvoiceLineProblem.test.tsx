import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.mock('@/features/products/productApi', () => ({ productApi: { search: vi.fn(async () => ({ data: [] })) } }))
import { cardLabel, InvoiceLineProblem, isSameNameProblem, sameNameCards } from './InvoiceLineProblem'
import type { Product } from '@/types/product'

// 26.11.2026, власник: «третій день не можу нормально розбирати товар» — 61 відмова каси «кілька карток із такою назвою».
const card = (id: string, name: string, sku: string, qty: number, retail: number) => ({ id, name, sku, qty_on_hand: qty, retail_price: retail }) as unknown as Product
const cards = [
  card('2', 'Запобіжники (плоскі міні 10А)  WTE M-10', '81072', 0, 300),
  card('1', 'запобіжники (плоскі міні 10А) WTE M-10', '82305', 50, 500),
  card('3', 'Запобіжники (плоскі міні 15А) WTE M-15 s', 'AUTO-ABC', 7, 500),
]

describe('refused invoice line: cards with the very same name are offered right in the row', () => {
  it('recognises the till and the form wording of the refusal', () => {
    expect(isSameNameProblem('Рядок 8: Є кілька товарів із точною назвою. Виберіть картку вручну.')).toBe(true)
    expect(isSameNameProblem('Повна назва «X» збігається з кількома товарами. Виберіть правильний товар вручну.')).toBe(true)
    expect(isSameNameProblem('Вкажіть назву товару')).toBe(false)
  })

  it('keeps only exact names (spaces and case aside), the card in stock first (letter «s» check)', () => {
    const found = sameNameCards(cards, 'Запобіжники (плоскі міні 10А) WTE M-10')
    expect(found.map(product => product.sku)).toEqual(['82305', '81072'])
    expect(sameNameCards(cards, 'Запобіжники (плоскі міні 15А) WTE M-15 s').map(product => product.id)).toEqual(['3'])
  })

  it('labels a card by what the owner recognises: article, stock, price', () => {
    expect(cardLabel(cards[1])).toBe('арт. 82305 · залишок 50 · 5.00 грн')
    expect(cardLabel(cards[2])).toBe('без артикула · залишок 7 · 5.00 грн')
  })

  it('another refusal keeps the plain text and the assistant button', () => {
    const html = renderToStaticMarkup(<InvoiceLineProblem name="Товар" message="Вкажіть назву товару" onChoose={() => undefined} onAsk={() => undefined} />)
    expect(html).toContain('Вкажіть назву товару')
    expect(html).toContain('Спитати помічника')
    expect(html).not.toContain('data-invoice-same-name')
  })
})
