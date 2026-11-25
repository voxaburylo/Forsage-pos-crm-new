import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Product } from '@/types/product'
import { analogActions, analogOrderPath, analogReceiptPath, analogRows, analogStock, analogsInStock, productIdFromParam } from './analogModel'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
const product = (id: string, name: string, qty: number, extra: Partial<Product> = {}) =>
  ({ id, name, sku: id.toUpperCase(), qty_on_hand: qty, retail_price: 10000, unit: 'шт', ...extra }) as Product

// 23.11.2026 (план B1b): аналоги видно в «Товарах» — у списку й у картці, а не лише в касі.
describe('stock analogs in «Товари»', () => {
  it('reads both answer shapes (till and server), drops the product itself, repeats and broken rows', () => {
    const rows = [product('a', 'Фільтр А', 0), product('self', 'Сам товар', 5), product('b', 'Фільтр Б', 3), product('b', 'Фільтр Б', 3), null, { id: 7 }] as Product[]
    for (const response of [{ analogs: rows, grouped: {} }, { data: rows }, rows]) {
      expect(analogRows('self', response).map(row => row.id)).toEqual(['b', 'a'])
    }
    for (const empty of [null, undefined, {}, { analogs: 'x' }, 'text']) expect(analogRows('self', empty)).toEqual([])
  })

  it('what is in stock comes first, then by name', () => {
    const rows = [product('z', 'Яблуко', 0), product('y', 'Булка', 2), product('x', 'Арка', 0), product('w', 'Вода', 1)]
    expect(analogRows('self', rows).map(row => row.name)).toEqual(['Булка', 'Вода', 'Арка', 'Яблуко'])
    expect(analogsInStock(analogRows('self', rows))).toBe(2)
  })

  it('the available quantity wins over the shelf quantity (reserves are not offered)', () => {
    expect(analogStock(product('a', 'А', 5, { qty_available: 1 }))).toBe(1)
    expect(analogStock(product('a', 'А', 5))).toBe(5)
    expect(analogStock({ qty_on_hand: undefined as unknown as number })).toBe(0)
    expect(analogsInStock([product('a', 'А', 5, { qty_available: 0 })])).toBe(0)
  })

  it('«to the receipt» only in the till program; «to an order» for those who keep orders', () => {
    expect(analogActions('cashier', true)).toEqual({ receipt: true, order: false })
    expect(analogActions('owner', true)).toEqual({ receipt: true, order: true })
    expect(analogActions('manager', true)).toEqual({ receipt: true, order: true })
    // У вебі продажу немає: гроші лише на касі.
    for (const role of ['owner', 'admin', 'manager', 'cashier']) expect(analogActions(role, false).receipt).toBe(false)
    expect(analogActions('owner', false).order).toBe(true)
    expect(analogActions('storekeeper', true)).toEqual({ receipt: false, order: false })
    expect(analogActions('', true)).toEqual({ receipt: false, order: false })
  })

  it('the buttons only pass the product id; the till and the order form add it in their usual way', () => {
    expect(analogReceiptPath('abc-1')).toBe('/pos?add=abc-1')
    expect(analogOrderPath('abc-1')).toBe('/orders/new?product=abc-1')
    expect(productIdFromParam('3f2c9a1e-0000-4000-8000-000000000001')).toBe('3f2c9a1e-0000-4000-8000-000000000001')
    for (const bad of [null, undefined, '', ' ', 'a b', "x' OR 1=1", '../etc', 'a'.repeat(129)]) expect(productIdFromParam(bad)).toBeNull()
    // Каса додає товар тим самим шляхом, що й вибір із пошуку: ціна, знижка, заборона нижче закупки.
    const till = read('../pos/SearchPanel.tsx')
    expect(till).toContain("productIdFromParam(params.get('add'))")
    expect(till).toContain('addRef.current(found.data)')
    const order = read('../orders/OrderFormPage.tsx')
    expect(order).toContain("productIdFromParam(searchParams.get('product'))")
    expect(order).toContain('addProductRef.current(found.data)')
  })

  it('the card shows the block above the numbers, the list has the button in both layouts', () => {
    const card = read('./ProductDetailPage.tsx')
    expect(card.indexOf('<StockAnalogsCard productId={product.id} sku={product.sku} />')).toBeGreaterThan(-1)
    expect(card.indexOf('<StockAnalogsCard productId={product.id} sku={product.sku} />')).toBeLessThan(card.indexOf('Крос-номери та аналоги</h3>'))
    expect(read('./ProductsPage.tsx').match(/<AnalogsButton productId=\{p\.id\} name=\{p\.name\} sku=\{p\.sku\} \/>/g)?.length).toBe(2)
  })
})
