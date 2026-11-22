import { describe, expect, it } from 'vitest'
import { checkTillOrder, normalizeOrderPhone, readOrderMoney, readOrderQty, tillOrderToCreate } from './tillOrderModel'

const item = { name: ' Колодки передні ', sku: 'GDB1330', qty: 2, sell_price: 125000, buy_price: 90000 }
const base = { customer_phone: '+38 (067) 123-45-67', customer_name: ' Іван ', car_make: 'Skoda', car_model: 'Octavia', car_year: 2015, items: [item] }

describe('order from the web through the till', () => {
  it('reads form numbers exactly and never substitutes a value', () => {
    expect(readOrderQty('1,5')).toBe(1.5)
    expect(readOrderMoney('1250,5', 'Ціна')).toBe(125050)
    expect(readOrderMoney('', 'Ціна')).toBe(0)
    for (const bad of ['0', '-1', 'abc', '1.2345', '']) expect(() => readOrderQty(bad)).toThrow()
    for (const bad of ['12.345', '1e3', '-5', '10 грн']) expect(() => readOrderMoney(bad, 'Ціна')).toThrow()
  })
  it('normalises the phone and refuses a broken one', () => {
    expect(normalizeOrderPhone('+38 (067) 123-45-67')).toBe('380671234567')
    expect(normalizeOrderPhone('')).toBe('')
    expect(() => normalizeOrderPhone('12345')).toThrow()
  })
  it('cleans the order and keeps only allowed fields', () => {
    const order = checkTillOrder({ ...base, prepayment: 5000, status: 'completed' })
    expect(order.customer_phone).toBe('380671234567')
    expect(order.customer_name).toBe('Іван')
    expect(order.items[0]).toEqual({ name: 'Колодки передні', sku: 'GDB1330', qty: 2, sell_price: 125000, buy_price: 90000 })
    expect(order).not.toHaveProperty('prepayment')
    expect(order).not.toHaveProperty('status')
  })
  it('refuses an order nobody could find, an empty one, and a price below purchase', () => {
    expect(() => checkTillOrder({ items: [item] })).toThrow(/телефон або ім/)
    expect(() => checkTillOrder({ ...base, items: [] })).toThrow(/хоча б одну/)
    expect(() => checkTillOrder({ ...base, items: [{ ...item, sell_price: 80000 }] })).toThrow(/нижча за закупку/)
    expect(() => checkTillOrder({ ...base, items: [{ ...item, name: ' ' }] })).toThrow(/Позиція 1/)
    expect(() => checkTillOrder({ ...base, vin: 'SHORT' })).toThrow(/VIN/)
    expect(() => checkTillOrder({ ...base, car_year: 1800 })).toThrow(/рік/)
    // Ціна ще невідома — дозволено: замовлення можна прорахувати на касі.
    expect(checkTillOrder({ ...base, items: [{ name: 'Фільтр', qty: 1, sell_price: 0 }] }).items[0].sell_price).toBe(0)
  })
  it('becomes an ordinary till order: same operation id, no money, no status from the web', () => {
    const body = tillOrderToCreate({ ...base, author: 'Олена', comment: 'Терміново' } as never, 'customer-1', 'op-1234567890abcdef')
    expect(body.operation_id).toBe('op-1234567890abcdef')
    expect(body.customer_id).toBe('customer-1')
    expect(body.comment).toBe('Оформлено у вебі: Олена\nТерміново')
    expect(body.items).toEqual([{ name: 'Колодки передні', sku: 'GDB1330', qty: 2, sell_price: 125000, buy_price: 90000, source_type: 'supplier' }])
    expect(body).not.toHaveProperty('prepayment')
    expect(body).not.toHaveProperty('initial_status')
    // Без телефону картку клієнта не створюємо — імʼя лишається в коментарі.
    expect(tillOrderToCreate({ customer_name: 'Петро', items: [item] }, null, 'op-1234567890abcdef').comment).toBe('Оформлено у вебі\nКлієнт: Петро')
  })
})
