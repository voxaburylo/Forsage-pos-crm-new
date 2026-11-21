import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalOrderRepository } from '../src/repositories/orderRepository'

/** Етап 10 плану (22.11.2026): проведена накладна відмічає «прибуло» в замовленнях і дає список «кому подзвонити». */
describe('posted invoice marks waiting order items as arrived', () => {
  let root: string, db: LocalDatabase, catalog: LocalCatalogRepository, orders: LocalOrderRepository
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-arrival-'))
    db = new LocalDatabase(root); catalog = new LocalCatalogRepository(db); orders = new LocalOrderRepository(db)
  })
  afterEach(() => { db.close(); if (path.basename(root).startsWith('forsage-arrival-')) rmSync(root, { recursive: true, force: true }) })
  const now = () => new Date().toISOString()
  // Проведена накладна вже збільшила залишок — у тесті ставимо його одразу.
  const product = (id: string, sku: string, name: string, qty = 10) => catalog.upsertProduct({ id, sku, name, qty_on_hand: qty })
  const customer = (id: string, name: string, phone: string) => db.prepare('INSERT INTO customers(id,tenant_id,full_name,phone,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, DEFAULT_TENANT_ID, name, phone, now(), now())
  const invoice = (id: string, status: string, rows: Array<[string, number]>) => {
    db.prepare('INSERT INTO supply_invoices(id,tenant_id,status,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, DEFAULT_TENANT_ID, status, now(), now())
    rows.forEach(([productId, qty], index) => db.prepare('INSERT INTO supply_invoice_items(id,tenant_id,invoice_id,product_id,qty,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(`${id}-${index}`, DEFAULT_TENANT_ID, id, productId, qty, now(), now()))
  }
  let serial = 0
  const order = (customerId: string | null, items: Array<Record<string, unknown>>) => orders.saveOrder({
    customer_id: customerId, initial_status: 'ordered', comment: 'Замовлення ' + ++serial,
    items: items.map(item => ({ qty: 1, sell_price: 10000, source_type: 'supplier', item_status: 'pending', ...item })),
  })
  const statuses = (orderId: string) => orders.getOrder(orderId).items.map((item: { item_status: string }) => item.item_status)

  it('matches by exact article, links the card, and returns who to call', () => {
    product('p-ball', 'CB0269', 'Опора шарова CTR CB0269'); product('p-other', 'ZZ-900', 'Інший товар')
    customer('c-1', 'Іван', '+380501112233')
    const waiting = order('c-1', [{ name: 'Шарова опора', sku: 'cb 0269', qty: 2 }, { name: 'Сайлентблок', sku: 'GV0164' }])
    invoice('inv-1', 'posted', [['p-ball', 2], ['p-other', 5]])
    const result = orders.applyInvoiceArrival('inv-1')
    expect(result.already_applied).toBe(false)
    expect(result.orders).toEqual([{ order_id: waiting.id, order_number: waiting.order_number, customer_name: 'Іван', customer_phone: '+380501112233',
      items: [{ name: 'Шарова опора', qty: 2 }], complete: false }])
    expect(statuses(waiting.id)).toEqual(['arrived', 'pending'])
    expect(orders.getOrder(waiting.id).items[0].product_id).toBe('p-ball')
    expect(result.shortages).toEqual([])
  })

  it('marks an order ready when everything arrived and matches a cross number too', () => {
    product('p-filter', 'W712/83', 'Фільтр масляний MANN W712/83')
    catalog.changeCrossNumbers('p-filter', { add: ['WL7125'] })
    const waiting = order(null, [{ name: 'Фільтр масляний', sku: 'WL-7125' }])
    invoice('inv-2', 'posted', [['p-filter', 1]])
    const result = orders.applyInvoiceArrival('inv-2')
    expect(result.orders[0]).toMatchObject({ complete: true, customer_name: null, customer_phone: null })
    expect(orders.getOrder(waiting.id).status).toBe('ready')
  })

  it('serves orders in their queue and reports the one that did not get enough', () => {
    product('p-pad', 'GDB1550', 'Колодки гальмівні TRW GDB1550')
    const first = order(null, [{ name: 'Колодки', sku: 'GDB1550', qty: 2 }])
    const second = order(null, [{ name: 'Колодки', sku: 'GDB1550', qty: 2 }])
    invoice('inv-3', 'posted', [['p-pad', 3]])
    const result = orders.applyInvoiceArrival('inv-3')
    expect(result.orders.map(row => row.order_id)).toEqual([first.id])
    expect(result.shortages).toEqual([{ order_number: second.order_number, name: 'Колодки', needed: 2, available: 1 }])
    expect(statuses(second.id)).toEqual(['pending'])
  })

  it('changes nothing on a repeat for the same invoice', () => {
    product('p-ball', 'CB0269', 'Опора шарова CTR CB0269')
    order(null, [{ name: 'Шарова', sku: 'CB0269' }])
    invoice('inv-4', 'posted', [['p-ball', 1]])
    const first = orders.applyInvoiceArrival('inv-4')
    const later = order(null, [{ name: 'Шарова', sku: 'CB0269' }])
    const again = orders.applyInvoiceArrival('inv-4')
    expect(again).toEqual({ ...first, already_applied: true })
    expect(statuses(later.id)).toEqual(['pending'])
  })

  it('never guesses: no article, a short article, a similar name, or an article shared by two received cards stay waiting', () => {
    product('p-a', 'AB12', 'Товар AB12'); product('p-b', 'XX-100', 'Опора шарова ліва'); product('p-c', 'XX-200', 'Опора шарова права')
    catalog.changeCrossNumbers('p-b', { add: ['SHARED77'] }); catalog.changeCrossNumbers('p-c', { add: ['SHARED77'] })
    const waiting = order(null, [{ name: 'Опора шарова ліва' }, { name: 'Товар', sku: 'AB1' }, { name: 'Опора', sku: 'SHARED77' }, { name: 'Послуга', sku: 'XX-100', item_type: 'service' }])
    invoice('inv-5', 'posted', [['p-a', 1], ['p-b', 1], ['p-c', 1]])
    const result = orders.applyInvoiceArrival('inv-5')
    expect(result.orders).toEqual([])
    expect(statuses(waiting.id)).toEqual(['pending', 'pending', 'pending', 'pending'])
  })

  it('keeps the item waiting when the stock cannot be reserved (it was sold into minus before)', () => {
    product('p-minus', 'MIN-0001', 'Товар у мінусі', 0)
    const waiting = order(null, [{ name: 'Товар', sku: 'MIN-0001' }])
    invoice('inv-7', 'posted', [['p-minus', 1]])
    const result = orders.applyInvoiceArrival('inv-7')
    expect(result.orders).toEqual([])
    expect(result.shortages).toEqual([{ order_number: waiting.order_number, name: 'Товар', needed: 1, available: 0 }])
    expect(statuses(waiting.id)).toEqual(['pending'])
    expect(orders.getOrder(waiting.id).items[0].product_id).toBeNull()
  })

  it('refuses a draft, an unknown invoice and skips closed or cancelled orders', () => {
    product('p-ball', 'CB0269', 'Опора шарова CTR CB0269')
    invoice('inv-draft', 'draft', [['p-ball', 1]])
    expect(() => orders.applyInvoiceArrival('inv-draft')).toThrow('лише після проведення')
    expect(() => orders.applyInvoiceArrival('missing')).toThrow('не знайдено')
    expect(() => orders.applyInvoiceArrival("x' OR 1=1")).toThrow('Некоректна накладна')
    const archived = orders.saveOrder({ initial_status: 'archived', items: [{ name: 'Шарова', sku: 'CB0269', qty: 1, sell_price: 100, source_type: 'supplier', item_status: 'pending' }] })
    invoice('inv-6', 'posted', [['p-ball', 1]])
    expect(orders.applyInvoiceArrival('inv-6').orders).toEqual([])
    expect(statuses(archived.id)).toEqual(['pending'])
  })
})
