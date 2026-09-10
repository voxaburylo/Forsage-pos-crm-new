import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Product } from '@/types/product'
vi.mock('@/features/products/productApi', () => ({ productApi: { getAnalogs: vi.fn() } }))
import { OrderProductResults } from './OrderProductResults'

describe('order catalogue results', () => {
  const product = (id: string, qty: number) => ({ id, name: `Фільтр ${id} — повна довга назва запчастини`, sku: id, qty_on_hand: qty, retail_price: 12300, unit: 'шт', storage_bin: 'А-3', barcode: '1234567890123' }) as Product
  it('shows full names, shelf, barcode and stock-first results', () => {
    const html = renderToStaticMarkup(<OrderProductResults products={[product('OUT', 0), product('IN', 4)]} onSelect={() => {}} />)
    expect(html.indexOf('Фільтр IN')).toBeLessThan(html.indexOf('Фільтр OUT'))
    expect(html).toContain('Полиця А-3')
    expect(html).toContain('1234567890123')
    expect(html).toContain('повна довга назва запчастини')
    expect(html).not.toContain('truncate')
  })
  it('offers analogues for out-of-stock products without inventing a zero count before loading', () => {
    const html = renderToStaticMarkup(<OrderProductResults products={[product('OUT', 0)]} onSelect={() => {}} />)
    expect(html).toContain('Аналоги')
    expect(html).toContain('Немає в наявності — під замовлення')
    expect(html).not.toContain('Аналоги (0)')
  })
  it('labels selection as replacement when editing an existing row', () => {
    const html = renderToStaticMarkup(<OrderProductResults products={[product('IN', 1)]} replacing onSelect={() => {}} />)
    expect(html).toContain('Замінити')
    expect(html).not.toContain('>Додати<')
  })
})
