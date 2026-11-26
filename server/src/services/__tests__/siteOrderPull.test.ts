import { beforeEach, describe, expect, it, vi } from 'vitest'

// 27.11.2026: замовлення із сайту зберігаються в програмі. База підмінена: перевіряємо, що саме пишеться й що йде касі.
const db = vi.hoisted(() => ({ calls: [] as Array<{ text: string; params: any[] }>, known: new Map<string, { id: string; canceled: boolean; site_status: string | null }>(), seq: 0 }))
vi.mock('../../db/pg.js', () => {
  const query = async (text: string, params: any[] = []) => {
    db.calls.push({ text, params })
    if (/INSERT INTO site_orders/.test(text)) {
      if (db.known.has(params[1])) return { rows: [] }
      const id = `row-${++db.seq}`
      db.known.set(params[1], { id, canceled: params[9], site_status: params[8] })
      return { rows: [{ id }] }
    }
    if (/SELECT id, canceled, site_status, program_order_id/.test(text)) { const row = db.known.get(params[1]); return { rows: row ? [{ ...row }] : [] } }
    if (/UPDATE site_orders SET site_status/.test(text)) { const row = db.known.get(params[1])!; row.site_status = params[2]; row.canceled = params[3]; return { rows: [] } }
    return { rows: [], rowCount: 0 }
  }
  return { pool: { query, connect: async () => ({ query, release: () => undefined }) } }
})
vi.mock('../tillWake.js', () => ({ wakeTill: vi.fn(async () => undefined) }))
import { isCanceled, kopecks, pullSiteOrders, siteOrderRow, tillOrderPayload } from '../siteOrderPull.js'

const order15 = {
  id: 15, created_at: '2026-11-26T10:00:00Z', status: 'new', customer_name: '  Іван  Петренко s ', customer_phone: '+38 (099) 167-44-24', delivery_method: 'Нова Пошта', city: 'Синельникове', warehouse: '№1',
  comment: 'Подзвоніть після 18', total: 1155.5,
  items: [{ product_id: 7, program_product_id: '11111111-2222-4333-8444-555555555555', title: 'Фільтр масляний MANN W712', qty: 2, price: 250 },
    { product_id: 9, program_product_id: null, title: 'Шина 205/55R16 Nexen', qty: 1, price: 655.5 }],
}
const commands = (name: string) => db.calls.filter(call => /INSERT INTO till_commands/.test(call.text) && call.text.includes(`'${name}'`))

describe('a site order becomes a row of the program', () => {
  it('number, customer, phone digits, delivery in one line, money in kopecks, our card when the site knows it', () => {
    const row = siteOrderRow(order15)!
    expect(row).toMatchObject({ external_id: '15', customer_name: 'Іван Петренко s', customer_phone: '380991674424', delivery: 'Нова Пошта, Синельникове, №1',
      comment: 'Подзвоніть після 18', total_amount: 115550, site_status: 'new', canceled: false, site_created_at: '2026-11-26T10:00:00.000Z' })
    expect(row.items).toEqual([
      { product_id: '11111111-2222-4333-8444-555555555555', name: 'Фільтр масляний MANN W712', sku: null, qty: 2, price: 25000 },
      { product_id: null, name: 'Шина 205/55R16 Nexen', sku: null, qty: 1, price: 65550 }])
  })

  it('a strange phone does not lose the order; an answer without a number is skipped; «canceled» in both spellings', () => {
    expect(siteOrderRow({ ...order15, customer_phone: '12345' })!.customer_phone).toBe('')
    expect(siteOrderRow({ ...order15, customer_name: '' })!.customer_name).toBe('Покупець сайту')
    expect(siteOrderRow({ status: 'new' })).toBeNull()
    expect([isCanceled('canceled'), isCanceled('Cancelled'), isCanceled('new')]).toEqual([true, true, false])
    expect(kopecks('1155.00')).toBe(115500)
    expect(kopecks('abc')).toBe(0)
  })

  it('the till gets an ordinary order with the source «site»; a canceled one is marked', () => {
    const blank = tillOrderPayload(siteOrderRow(order15)!)
    expect(blank).toMatchObject({ source: 'site', canceled: false, customer_phone: '380991674424', author: 'Сайт' })
    expect(blank.comment).toBe('Замовлення із сайту № 15. Доставка: Нова Пошта, Синельникове, №1. Подзвоніть після 18')
    expect(blank.items[0]).toEqual({ name: 'Фільтр масляний MANN W712', sku: null, qty: 2, sell_price: 25000, product_id: '11111111-2222-4333-8444-555555555555' })
    expect(blank.items[1]).toEqual({ name: 'Шина 205/55R16 Nexen', sku: null, qty: 1, sell_price: 65550 })
    const canceled = tillOrderPayload(siteOrderRow({ ...order15, status: 'canceled' })!)
    expect(canceled.canceled).toBe(true)
    expect(canceled.comment).toMatch(/^Замовлення із сайту № 15\. СКАСОВАНО на сайті\./)
  })
})

describe('pulling orders from the site', () => {
  beforeEach(() => { db.calls.length = 0; db.known.clear(); db.seq = 0 })
  const run = (list: unknown[]) => pullSiteOrders('shop', 'owner', { gateway: async (action, params) => { expect(action).toBe('orders.list'); expect(params).toEqual({ limit: 50, offset: 0 }); return list }, wake: async () => undefined })
  const anyCommand = () => db.calls.filter(call => /INSERT INTO till_commands/.test(call.text))

  // Рішення власника: «навіщо плутати замовлення інтернет-магазину з касою?» — на касу саме нічого не йде.
  it('a new order is saved once and NOTHING is sent to the till; the second pass writes nothing', async () => {
    expect(await run([order15])).toEqual({ seen: 1, saved: 1, canceled: 0 })
    const insert = db.calls.find(call => /INSERT INTO site_orders/.test(call.text))!
    expect([insert.params[0], insert.params[1], insert.params[7]]).toEqual(['shop', '15', 115550])
    expect(anyCommand()).toHaveLength(0)
    db.calls.length = 0
    expect(await run([order15])).toEqual({ seen: 1, saved: 0, canceled: 0 })
    expect(db.calls.some(call => /UPDATE site_orders SET site_status/.test(call.text))).toBe(false)
    expect(anyCommand()).toHaveLength(0)
  })

  it('an order already canceled on the site is saved too — with the mark', async () => {
    expect(await run([{ ...order15, id: 16, status: 'canceled' }])).toEqual({ seen: 1, saved: 1, canceled: 1 })
    const insert = db.calls.find(call => /INSERT INTO site_orders/.test(call.text))!
    expect([insert.params[1], insert.params[8], insert.params[9]]).toEqual(['16', 'canceled', true])
    expect(anyCommand()).toHaveLength(0)
  })

  it('canceled later: the row is marked; the till is told only when a program order was made by the button', async () => {
    await run([order15])
    db.calls.length = 0
    expect(await run([{ ...order15, status: 'canceled' }])).toEqual({ seen: 1, saved: 0, canceled: 1 })
    expect(db.known.get('15')).toMatchObject({ canceled: true, site_status: 'canceled' })
    expect(commands('order.site_cancel')).toHaveLength(0)

    await run([{ ...order15, id: 18 }])
    ;(db.known.get('18') as any).program_order_id = '99999999-2222-4333-8444-555555555555'
    db.calls.length = 0
    expect(await run([{ ...order15, id: 18, status: 'canceled' }])).toMatchObject({ canceled: 1 })
    expect(commands('order.site_cancel')).toHaveLength(1)
    expect(commands('order.site_cancel')[0].params.slice(1, 3)).toEqual(['18', '99999999-2222-4333-8444-555555555555'])
    db.calls.length = 0
    await run([{ ...order15, id: 18, status: 'canceled' }])
    expect(commands('order.site_cancel')).toHaveLength(0)
  })

  it('a status change that is not a cancel only updates the row; an order without items is saved as well', async () => {
    await run([order15])
    await run([{ ...order15, status: 'shipped' }])
    expect(db.known.get('15')).toMatchObject({ canceled: false, site_status: 'shipped' })
    expect(await run([{ ...order15, id: 17, items: [] }])).toMatchObject({ saved: 1 })
    expect(anyCommand()).toHaveLength(0)
  })
})
