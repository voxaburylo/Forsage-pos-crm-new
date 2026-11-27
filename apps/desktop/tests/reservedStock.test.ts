import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { RESERVED_ORDER_TAG, SITE_PAID_MARK, reservedStockProblem } from '../src/repositories/pos/reservedStock'

// 27.11.2026, завдання власника: «оплачені замовлення із сайту бронюють товар; каса не дає продати заброньоване;
// показати "Товар у замовленні №… (сайт, оплачено)" з кнопкою відкрити замовлення». Дані з літерою «s».
describe('the till does not sell stock reserved for an order', () => {
  let root = '', db: LocalDatabase, catalog: LocalCatalogRepository, pos: LocalPosRepository
  const cashierId = randomUUID(), shiftId = randomUUID()

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-reserved-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
    pos = new LocalPosRepository(db)
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO shifts (id, tenant_id, cashier_id, status, opening_cash, opened_at, created_at, updated_at) VALUES (?, ?, ?, 'open', 0, ?, ?, ?)`)
      .run(shiftId, DEFAULT_TENANT_ID, cashierId, now, now, now)
  })
  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-reserved-')) rmSync(root, { recursive: true, force: true })
  })

  const product = (qty: number) => catalog.upsertProduct({ id: randomUUID(), sku: `RS-${randomUUID()}`, name: 'Фільтр s', qty_on_hand: qty, purchase_price: 50, retail_price: 100 })
  function siteOrder(productId: string, qty: number, paid: boolean) {
    const now = new Date().toISOString(), orderId = randomUUID()
    db.prepare(`INSERT INTO customer_orders (id, tenant_id, order_number, status, source, comment, total_amount, created_at, updated_at) VALUES (?, ?, 'S-17', 'new', 'site', ?, 100, ?, ?)`)
      .run(orderId, DEFAULT_TENANT_ID, paid ? `${SITE_PAID_MARK} (онлайн): 100,00 грн` : 'Замовлення із сайту s', now, now)
    db.prepare(`INSERT INTO stock_reserves (id, tenant_id, product_id, order_id, qty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), DEFAULT_TENANT_ID, productId, orderId, qty, now, now)
    return orderId
  }
  const allowNegative = () => db.prepare(`INSERT INTO app_meta(key, value_json, updated_at) VALUES ('shop_settings', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(JSON.stringify({ allow_negative_qty: true }), new Date().toISOString())
  const sell = (productId: string, qty: number) => pos.checkout({ cashier_id: cashierId, shift_id: shiftId, items: [{ product_id: productId, qty, unit_price: 100 }], payments: [{ method: 'cash', amount: 100 * qty }] })

  it('names the paid site order and carries its id for the "open order" button', () => {
    const stored = product(1)
    const orderId = siteOrder(stored.id, 1, true)
    let message = ''
    try { sell(stored.id, 1) } catch (error) { message = (error as Error).message }
    expect(message).toContain('у замовленні №S-17 (сайт, оплачено)')
    expect(message).toContain('Доступно: 0, потрібно: 1')
    expect(RESERVED_ORDER_TAG.exec(message)?.[1]).toBe(orderId)
    expect(catalog.findById(stored.id)?.qty_on_hand).toBe(1)
  })

  it('blocks reserved stock even when selling into minus is on, but free stock and plain minus still sell', () => {
    allowNegative()
    const reserved = product(2)
    siteOrder(reserved.id, 1, true)
    expect(() => sell(reserved.id, 2)).toThrow('(сайт, оплачено)')
    sell(reserved.id, 1)
    expect(catalog.findById(reserved.id)?.qty_on_hand).toBe(1)
    // Товару немає й ніхто його не бронював — продаж у мінус, як і раніше.
    const empty = product(0)
    sell(empty.id, 1)
    expect(catalog.findById(empty.id)?.qty_on_hand).toBe(-1)
  })

  it('a reservation released by issuing or cancelling the order frees the stock', () => {
    const stored = product(1)
    siteOrder(stored.id, 1, false)
    expect(() => sell(stored.id, 1)).toThrow('(сайт)')
    db.prepare('UPDATE stock_reserves SET released_at = ?').run(new Date().toISOString())
    sell(stored.id, 1)
    expect(catalog.findById(stored.id)?.qty_on_hand).toBe(0)
  })

  it('explains plainly', () => {
    expect(reservedStockProblem({ name: 's', qtyOnHand: 3, requested: 2, allowNegative: false, holders: [] })).toBeNull()
    expect(reservedStockProblem({ name: 's', qtyOnHand: 0, requested: 1, allowNegative: true, holders: [] })).toBeNull()
    expect(reservedStockProblem({ name: 's', qtyOnHand: 0, requested: 1, allowNegative: false, holders: [] })?.message).toContain('Продаж при відсутності товару')
  })
})
