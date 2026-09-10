import { describe, expect, it } from 'vitest'
import { availableStock, canUseOrderCash, isReadyOrderStatus, isWorkOrderStatus, orderEditPath, orderNumber, stockFirst, validateOrderRows, replaceOrderProduct } from './orderUx'
import type { Product } from '@/types/product'

describe('order editor workflow', () => {
  it.each(['ready', 'arrived', 'called', 'no_answer'])('keeps %s in the ready queue, not supply queue', (status) => {
    expect(isReadyOrderStatus(status)).toBe(true)
    expect(isWorkOrderStatus(status)).toBe(false)
  })
  it.each(['new', 'in_progress', 'ordered'])('keeps %s in work', (status) => {
    expect(isWorkOrderStatus(status)).toBe(true)
    expect(isReadyOrderStatus(status)).toBe(false)
  })
  it.each(['manager', 'tire_worker', undefined])('does not offer payment to %s', (role) => expect(canUseOrderCash(role)).toBe(false))
  it.each(['owner', 'admin', 'cashier'])('offers payment to %s', (role) => expect(canUseOrderCash(role)).toBe(true))
  it('retains relevance order inside availability groups without mutating search results', () => {
    const rows = [{ id: 'a', qty_on_hand: 4, qty_available: 0 }, { id: 'b', qty_on_hand: 2 }, { id: 'c', qty_on_hand: 0 }, { id: 'd', qty_on_hand: 1 }]
    expect(stockFirst(rows).map((row) => row.id)).toEqual(['b', 'd', 'a', 'c'])
    expect(rows[0].id).toBe('a')
    expect(availableStock(rows[0])).toBe(0)
  })
  it('preserves the correct editor for priced drafts and handwritten notes', () => {
    expect(orderEditPath({ id: '1', items: [{}] })).toBe('/orders/1/edit')
    expect(orderEditPath({ id: '2', items: [{ is_draft_note: true }] })).toBe('/quotes/2')
  })
  it('accepts comma decimals and currency grouping', () => expect(orderNumber('1 700,50')).toBe(1700.5))
  const row = { name: 'Фільтр', qty: '2', sell_price: '250,50', buy_price: '100', stock: 3, source_type: 'warehouse' }
  it('validates ordinary priced rows', () => expect(validateOrderRows([row])).toBeNull())
  it('replaces identity and cost, preserving the order quantity and agreed sale price', () => {
    const product = { id: 'new', name: 'Аналог', sku: 'ABC', qty_on_hand: 5, purchase_price: 12300, retail_price: 30000 } as Product
    const replaced = replaceOrderProduct({ ...row, id: 'line-1', supplier_id: 'old', expected_date: '2026-10-01' }, product)
    expect(replaced).toMatchObject({ id: 'line-1', product_id: 'new', name: 'Аналог', sku: 'ABC', qty: '2', sell_price: '250,50', buy_price: '123.00', supplier_id: '', expected_date: '', source_type: 'warehouse' })
    expect(replaceOrderProduct(row, { ...product, qty_on_hand: 0 }).source_type).toBe('supplier')
    const reserved = { ...row, product_id: product.id }
    expect(replaceOrderProduct(reserved, { ...product, qty_on_hand: 0, qty_available: 0 })).toBe(reserved)
  })
  it.each(['0', '-1', '', 'abc'])('rejects quantity %s instead of silently saving one', (qty) => expect(validateOrderRows([{ ...row, qty }])).toContain('кількість'))
  it.each(['-5', 'abc', ''])('rejects invalid sale price %s', (sell_price) => expect(validateOrderRows([{ ...row, sell_price }])).toContain('ціну'))
  it('warns immediately about stock shortage but permits explicit backorders', () => {
    expect(validateOrderRows([{ ...row, qty: '4' }])).toContain('доступно 3')
    expect(validateOrderRows([{ ...row, qty: '4', source_type: 'supplier' }])).toBeNull()
    expect(validateOrderRows([{ ...row, qty: '4', item_type: 'service' }])).toBeNull()
  })
})
