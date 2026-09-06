import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalInventoryRepository } from '../src/repositories/inventoryRepository'
import { LocalWarehouseRepository } from '../src/repositories/warehouseRepository'

describe('document boundaries never silently change local stock', () => {
  let root: string
  let db: LocalDatabase
  let catalog: LocalCatalogRepository
  let inventory: LocalInventoryRepository
  let warehouse: LocalWarehouseRepository
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-document-boundary-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
    inventory = new LocalInventoryRepository(db)
    warehouse = new LocalWarehouseRepository(db)
  })
  afterEach(() => {
    db.close()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-document-boundary-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })
  function product() {
    return catalog.upsertProduct({ id: randomUUID(), sku: randomUUID(), name: 'Товар перевірки', qty_on_hand: 8, retail_price: 100 })
  }
  function revision() {
    const session = inventory.createSession({ name: 'Перевірка' })
    inventory.startSession(session.id)
    const item = product()
    const result = inventory.scan(session.id, { product_id: item.id })
    return { session, item, row: result.item }
  }
  it.each([NaN, Infinity, -Infinity])('rejects invalid count %s without changing the row', value => {
    const { session, row } = revision()
    expect(() => inventory.setItemQty(session.id, row.id, { counted_stock: value })).toThrow(/кількість/i)
    expect(inventory.getSessionData(session.id).items[0].counted_stock).toBe(1)
  })
  it('rolls back count editing if touching the document fails', () => {
    const { session, row } = revision()
    db.exec(`CREATE TRIGGER fail_session BEFORE UPDATE ON inventory_sessions BEGIN SELECT RAISE(ABORT, 'test failure'); END`)
    expect(() => inventory.setItemQty(session.id, row.id, { counted_stock: 12 })).toThrow('test failure')
    expect(inventory.getSessionData(session.id).items[0].counted_stock).toBe(1)
  })
  it('refuses a missing row instead of reporting successful editing', () => {
    const { session } = revision()
    expect(() => inventory.setItemQty(session.id, randomUUID(), { counted_stock: 12 })).toThrow(/не знайдено/i)
  })
  it('does not complete a revision containing a deleted product', () => {
    const { session, item } = revision()
    catalog.deleteProduct(item.id)
    const before = db.prepare('SELECT qty_on_hand FROM products WHERE id = ?').get(item.id)
    expect(() => inventory.complete(session.id)).toThrow(/видален|неактив/i)
    expect(inventory.getSessionData(session.id).status).toBe('in_progress')
    expect(db.prepare('SELECT qty_on_hand FROM products WHERE id = ?').get(item.id)).toEqual(before)
  })
  it('returns success on repeated completion without applying the count again', () => {
    const { session, item } = revision()
    const first = inventory.complete(session.id)
    db.prepare('UPDATE products SET qty_on_hand = 0 WHERE id = ?').run(item.id)
    expect(inventory.complete(session.id)).toEqual(first)
    expect(catalog.findById(item.id)?.qty_on_hand).toBe(0)
    expect(db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE operation_type = 'inventory.completed'").get()).toEqual({ n: 1 })
  })
  it('cannot change a price through a completed revision', () => {
    const { session, item } = revision()
    inventory.complete(session.id)
    expect(() => inventory.applyPrice(session.id, { product_id: item.id, retail_price: 1 })).toThrow(/не активна/i)
    expect(catalog.findById(item.id)?.retail_price).toBe(100)
  })
  it('rolls back reserve creation when its upload record fails', () => {
    const item = product()
    db.exec(`CREATE TRIGGER fail_reserve BEFORE INSERT ON sync_outbox WHEN NEW.operation_type = 'reserve.created' BEGIN SELECT RAISE(ABORT, 'test failure'); END`)
    expect(() => warehouse.createReserve({ product_id: item.id, qty: 3 })).toThrow('test failure')
    expect(warehouse.listReserves()).toHaveLength(0)
  })
  it('rolls back reserve release when its upload record fails', () => {
    const reserve = warehouse.createReserve({ product_id: product().id, qty: 3 })
    db.exec(`CREATE TRIGGER fail_release BEFORE INSERT ON sync_outbox WHEN NEW.operation_type = 'reserve.released' BEGIN SELECT RAISE(ABORT, 'test failure'); END`)
    expect(() => warehouse.releaseReserve(reserve.id)).toThrow('test failure')
    expect(warehouse.listReserves()).toHaveLength(1)
  })
})
