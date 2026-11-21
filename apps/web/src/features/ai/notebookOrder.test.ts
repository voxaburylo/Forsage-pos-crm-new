import { describe, expect, it } from 'vitest'
import { aiOrderPayload, notebookInitialStatus, supplierNameKey } from './localAiAction'

/** Рішення власника 21.11.2026: як читати сторінку блокнота. */
describe('notebook order → order in the program', () => {
  const item = (extra: Record<string, unknown> = {}) => ({ name: 'Сайлентблок зад', qty: 4, sell_price_uah: 300, ...extra })
  const suppliers = [{ id: 's-elit', name: 'ELIT' }, { id: 's-tex', name: 'ТЕХ' }]

  it('maps crossed-out, ticks and phone tick to the order state', () => {
    expect(notebookInitialStatus({ items: [item()] })).toBe('ordered')
    expect(notebookInitialStatus({ items: [item({ arrived: true }), item()] })).toBe('ordered')
    expect(notebookInitialStatus({ items: [item({ arrived: true })] })).toBe('arrived')
    expect(notebookInitialStatus({ customer_notified: true, items: [item({ arrived: true })] })).toBe('called')
    expect(notebookInitialStatus({ is_done: true, customer_notified: true, items: [item()] })).toBe('archived')
    expect(notebookInitialStatus({ items: [] })).toBe('ordered')
  })

  it('links a known supplier written in Latin or Cyrillic and keeps an unknown one in the comment', () => {
    expect(supplierNameKey('тех')).toBe(supplierNameKey('TEX'))
    expect(supplierNameKey(' Elit ')).toBe(supplierNameKey('ELIT'))
    const order = aiOrderPayload({ customer_phone: '+380501112233', items: [item({ supplier: 'TEX' }), item({ supplier: 'elit' }), item({ supplier: 'Омега' }), item()] }, suppliers)
    expect(order.items.map(row => row.supplier_id)).toEqual(['s-tex', 's-elit', null, null])
    expect(order.comment).toBe('Постачальник: Омега')
    expect(order.items.every(row => !row.name.includes('TEX'))).toBe(true)
  })

  it('does not guess between two supplier cards with the same name', () => {
    const order = aiOrderPayload({ items: [item({ supplier: 'ELIT' })] }, [...suppliers, { id: 's-elit-2', name: 'Elit' }])
    expect(order.items[0].supplier_id).toBeNull()
    expect(order.comment).toBe('Постачальник: ELIT')
  })

  it('marks "paid" as a plain note and never as money', () => {
    const order = aiOrderPayload({ is_paid: true, comment: 'Fiat Doblo', items: [item({ arrived: true })] }, suppliers)
    expect(order.comment).toBe('Оплачено\nFiat Doblo')
    expect(order.prepayment).toBeUndefined()
    expect(order.prepayment_method).toBeUndefined()
    expect(order.initial_status).toBe('arrived')
  })

  it('keeps "client was called" visible when not every part has arrived yet', () => {
    const order = aiOrderPayload({ customer_notified: true, items: [item({ arrived: true }), item()] }, suppliers)
    expect(order.initial_status).toBe('ordered')
    expect(order.comment).toBe('Клієнту подзвонили')
  })

  it('rejects malformed marks instead of guessing', () => {
    expect(() => aiOrderPayload({ is_done: 'так', items: [item()] })).toThrow('Некоректна позначка')
    expect(() => aiOrderPayload({ items: [item({ supplier: 5 })] })).toThrow('постачальник')
  })
})
