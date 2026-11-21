import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalOrderRepository } from '../src/repositories/orderRepository'

/** Етап 3 плану (22.11.2026): довідник запчастин «під замовлення» з історії замовлень. */
describe('order part suggestions from past orders', () => {
  let root: string, db: LocalDatabase, orders: LocalOrderRepository
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-parts-')); db = new LocalDatabase(root); orders = new LocalOrderRepository(db) })
  afterEach(() => { db.close(); if (path.basename(root).startsWith('forsage-parts-')) rmSync(root, { recursive: true, force: true }) })
  const item = (extra: Record<string, unknown>) => ({ qty: 1, sell_price: 10000, buy_price: 7000, source_type: 'supplier', item_status: 'pending', ...extra })
  const order = (items: Array<Record<string, unknown>>, comment: string) => orders.saveOrder({ comment, items })

  it('finds a part by the first letters of a Cyrillic name or by article written any way', () => {
    order([item({ name: 'Сайлентблок задній CTR', sku: 'GV-0164', sell_price: 120000, buy_price: 80000 })], 'a')
    order([item({ name: 'Опора шарова Lemförder', sku: '37265 01' })], 'b')
    expect(orders.suggestOrderParts('сайл').map(row => row.name)).toEqual(['Сайлентблок задній CTR'])
    expect(orders.suggestOrderParts('САЙЛЕНТ')[0]).toMatchObject({ sku: 'GV-0164', sell_price: 120000, buy_price: 80000, supplier_id: null })
    expect(orders.suggestOrderParts('gv0164').map(row => row.sku)).toEqual(['GV-0164'])
    expect(orders.suggestOrderParts('3726501').map(row => row.name)).toEqual(['Опора шарова Lemförder'])
    expect(orders.suggestOrderParts('с')).toEqual([])
    expect(orders.suggestOrderParts('немає такого')).toEqual([])
  })

  it('keeps the most recent prices for the same part and lists it once', async () => {
    order([item({ name: 'Фільтр масляний', sku: 'W712/83', sell_price: 30000, buy_price: 20000 })], 'a')
    await new Promise(resolve => setTimeout(resolve, 5))
    order([item({ name: 'фільтр масляний', sku: 'w712/83', sell_price: 35000, buy_price: 24000 })], 'b')
    const found = orders.suggestOrderParts('w712')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ sell_price: 35000, buy_price: 24000 })
  })

  it('never suggests stock cards, services, cancelled lines or deleted orders', () => {
    new LocalCatalogRepository(db).upsertProduct({ id: 'p-1', sku: 'STOCK-1', name: 'Складський фільтр', qty_on_hand: 5 })
    order([item({ name: 'Складський фільтр', sku: 'STOCK-1', product_id: 'p-1', source_type: 'warehouse' }), item({ name: 'Фільтр послуга заміни', item_type: 'service' }),
      item({ name: 'Фільтр скасований', sku: 'X-1', item_status: 'canceled' })], 'a')
    const deleted = order([item({ name: 'Фільтр з видаленого замовлення', sku: 'X-2' })], 'b')
    orders.deleteOrder(deleted.id)
    expect(orders.suggestOrderParts('фільтр')).toEqual([])
  })

  it('shows the supplier the part was ordered from', () => {
    const now = new Date().toISOString()
    db.prepare('INSERT INTO suppliers(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('s-elit', DEFAULT_TENANT_ID, 'ELIT', now, now)
    order([item({ name: 'Втулка стабілізатора', sku: '17006', supplier_id: 's-elit' })], 'a')
    expect(orders.suggestOrderParts('втулка')[0]).toMatchObject({ supplier_id: 's-elit', supplier_name: 'ELIT' })
  })
})
