import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { orderItemPreview, readOrderList } from './orderConvenience'
import { OrderReadError } from './OrderReadError'

describe('order customer read outcomes', () => {
  it('distinguishes a successful empty response from a failed request and retries the same query', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: [] })
    const query = '0671234567'
    expect(await readOrderList(() => read(query), 'Не вдалося перевірити клієнта')).toEqual({ error: 'Не вдалося перевірити клієнта' })
    expect(await readOrderList(() => read(query), 'Не вдалося перевірити клієнта')).toEqual({ data: [] })
    expect(read.mock.calls).toEqual([[query], [query]])
  })
  it('does not describe malformed responses as an empty customer history', async () => {
    expect(await readOrderList(() => Promise.resolve({} as { data: unknown[] }), 'Історія недоступна')).toEqual({ error: 'Історія недоступна' })
  })
  it('renders an explicit read failure with a retry, not a duplicate-create suggestion', () => {
    const html = renderToStaticMarkup(<OrderReadError message="Не вдалося перевірити клієнта" onRetry={() => {}} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('Повторити завантаження')
    expect(html).not.toContain('не знайдено')
    expect(html).not.toContain('Створити')
  })
  it('wires current-query retry and prevents create after an unsuccessful check', () => {
    const source = readFileSync(new URL('./OrderFormPage.tsx', import.meta.url), 'utf8')
    expect(source).toContain('customerPhoneFromSearch(customerSearch)')
    expect(source).toContain('customerReadRevision')
    expect(source).toContain('customerListError ? (')
    expect(source).toContain('disabled={customerListLoading || Boolean(customerListError)}')
    expect(source).toContain('if (customerListLoading || customerListError) return')
    const history = readFileSync(new URL('./OrdersPage.tsx', import.meta.url), 'utf8')
    expect(history).toContain('historyError ? (')
    expect(history).toContain('vehicleError ? (')
    expect(history).toContain('searchError && <OrderReadError')
  })
})

describe('order item previews', () => {
  const items = Array.from({ length: 30 }, (_, index) => ({ id: String(index), name: `Фільтр ${index}`, sku: `SKU-${index}`, item_status: 'pending', is_draft_note: false }))
  it.each([1, 3, 4, 30])('reports all %i positions, not just the first three', count => {
    const result = orderItemPreview(items.slice(0, count), '')
    expect(result.total).toBe(count)
    expect(result.items).toHaveLength(Math.min(3, count))
    expect(result.remaining).toBe(Math.max(0, count - 3))
  })
  it('puts a matching last position first without mutating the order or duplicating rows', () => {
    const result = orderItemPreview(items, 'sku-29')
    expect(result.items.map(item => item.id)).toEqual(['29', '0', '1'])
    expect(result.remaining).toBe(27)
    expect(items[0].id).toBe('0')
  })
  it('keeps canceled positions visible and counted but excludes draft notes', () => {
    const result = orderItemPreview([...items.slice(0, 3), { ...items[3], item_status: 'canceled' }, { ...items[4], is_draft_note: true }], 'SKU-3')
    expect(result.total).toBe(4)
    expect(result.items[0].item_status).toBe('canceled')
    expect(result.remaining).toBe(1)
  })
  it('matches case-insensitive name tokens in either order and preserves original order when searching the customer', () => {
    expect(orderItemPreview(items, '29 ФІЛЬТР').items[0].id).toBe('29')
    expect(orderItemPreview(items, 'Петренко').items.map(item => item.id)).toEqual(['0', '1', '2'])
    expect(orderItemPreview([], '')).toEqual({ items: [], total: 0, remaining: 0 })
  })
})
