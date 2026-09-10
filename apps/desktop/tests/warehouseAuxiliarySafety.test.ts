import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalWarehouseRepository } from '../src/repositories/warehouseRepository'
import { LocalOrderRepository } from '../src/repositories/orderRepository'

describe('local auxiliary warehouse documents', () => {
  let root: string, db: LocalDatabase, warehouse: LocalWarehouseRepository, productId: string, employeeId: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-auxiliary-'))
    db = new LocalDatabase(root)
    warehouse = new LocalWarehouseRepository(db)
    productId = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: randomUUID(), name: 'Oil test', qty_on_hand: 8, purchase_price: 123, storage_bin: 'OLD-BIN' }).id
    employeeId = randomUUID()
    const timestamp = new Date().toISOString()
    db.prepare("INSERT INTO staff_users (id, tenant_id, full_name, role, is_active, created_at, updated_at) VALUES (?, ?, 'Worker', 'manager', 1, ?, ?)").run(employeeId, DEFAULT_TENANT_ID, timestamp, timestamp)
  })
  afterEach(() => {
    db.close()
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-auxiliary-')) rmSync(root, { recursive: true, force: true })
  })
  const stock = () => (db.prepare('SELECT qty_on_hand qty FROM products WHERE id = ?').get(productId) as { qty: number }).qty
  it('replays a movement without returning another movement or appending old bins', () => {
    const input = { operation_id: randomUUID(), product_id: productId, qty: 8, from_bin: 'OLD-BIN', to_bin: 'NEW-BIN' }
    const first = warehouse.createMovement(input)
    warehouse.createMovement({ product_id: productId, qty: 8, from_bin: 'NEW-BIN', to_bin: 'LAST-BIN' })
    expect(warehouse.createMovement(input)).toEqual(first)
    const product = db.prepare('SELECT storage_bin, search_text FROM products WHERE id = ?').get(productId) as any
    expect(product.storage_bin).toBe('LAST-BIN')
    expect(product.search_text).not.toContain('old-bin')
    expect(stock()).toBe(8)
  })
  it('rejects stale and partial movement instead of changing the whole product silently', () => {
    expect(() => warehouse.createMovement({ product_id: productId, qty: 2, to_bin: 'B' })).toThrow('увесь залишок')
    expect(() => warehouse.createMovement({ product_id: productId, qty: 8, from_bin: 'STALE', to_bin: 'B' })).toThrow('змінилася')
  })
  it('replays a reserve once and its release once', () => {
    const input = { operation_id: randomUUID(), product_id: productId, qty: 3 }
    const first = warehouse.createManualReserve(input)
    expect(warehouse.createManualReserve(input)).toEqual(first)
    expect(warehouse.listReserves()).toHaveLength(1)
    warehouse.releaseManualReserve(first.id)
    expect(warehouse.releaseManualReserve(first.id)).toEqual({ ok: true })
    expect(db.prepare("SELECT count(*) n FROM sync_outbox WHERE operation_type = 'reserve.released'").get()).toEqual({ n: 1 })
  })
  it.each(['invalid', '2000-01-01T00:00:00Z'])('rejects invalid reserve expiration %s', expires_at => {
    expect(() => warehouse.createManualReserve({ product_id: productId, qty: 1, expires_at })).toThrow('майбутньому')
    expect(warehouse.listReserves()).toHaveLength(0)
  })
  it('manual reserve endpoints cannot bypass an order reservation', () => {
    const order = new LocalOrderRepository(db).saveOrder({ manager_id: employeeId, items: [] })
    const reserve = warehouse.createReserve({ product_id: productId, qty: 1, order_id: order.id })
    expect(() => warehouse.releaseManualReserve(reserve.id)).toThrow('замовленням')
    expect(() => warehouse.createManualReserve({ product_id: productId, qty: 1, order_id: order.id })).toThrow('картки замовлення')
    warehouse.releaseReserve(reserve.id)
  })
  it('posts consumption using database prices and keeps fractional quantity', () => {
    const result = warehouse.createConsumption({ employee_id: employeeId, items: [{ product_id: productId, qty: 0.5, buy_price: 0 } as any] })
    expect(result.total_cost).toBe(62)
    expect(stock()).toBe(7.5)
    expect(warehouse.getWriteoff(result.writeoff_id).items[0].cost_kopecks).toBe(62)
    const month = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit' }).format(new Date())
    expect(warehouse.listConsumptions({ month }).summary[0]).toMatchObject({ total_cost: 62, items_count: 0.5 })
  })
  it('rejects consumption of reserved stock and duplicate lines', () => {
    warehouse.createReserve({ product_id: productId, qty: 7 })
    expect(() => warehouse.createConsumption({ employee_id: employeeId, items: [{ product_id: productId, qty: 2 }] })).toThrow('вільного')
    expect(() => warehouse.createConsumption({ employee_id: employeeId, items: [{ product_id: productId, qty: 1 }, { product_id: productId, qty: 1 }] })).toThrow('кілька разів')
    expect(stock()).toBe(8)
  })
  it('does not lose stock or create a partial act if consumption header fails', () => {
    db.exec("CREATE TRIGGER fail_consumption BEFORE INSERT ON internal_consumptions BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    expect(() => warehouse.createConsumption({ operation_id: randomUUID(), employee_id: employeeId, items: [{ product_id: productId, qty: 1 }] })).toThrow('test failure')
    expect(stock()).toBe(8)
    expect(db.prepare('SELECT count(*) n FROM writeoffs').get()).toEqual({ n: 0 })
    expect(db.prepare("SELECT count(*) n FROM inventory_movements WHERE source_type = 'writeoff'").get()).toEqual({ n: 0 })
  })
  it('consumption retry survives database reopen without a second writeoff', () => {
    const input = { operation_id: randomUUID(), employee_id: employeeId, items: [{ product_id: productId, qty: 2 }] }
    const first = warehouse.createConsumption(input)
    db.close(); db = new LocalDatabase(root); warehouse = new LocalWarehouseRepository(db)
    expect(warehouse.createConsumption(input)).toEqual(first)
    expect(stock()).toBe(6)
    expect(db.prepare('SELECT count(*) n FROM writeoffs').get()).toEqual({ n: 1 })
  })
})
