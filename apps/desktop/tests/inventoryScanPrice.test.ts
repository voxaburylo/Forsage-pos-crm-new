import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalInventoryRepository } from '../src/repositories/inventoryRepository'

describe('scanning counts products but does not inspect prices', () => {
  let root: string
  let db: LocalDatabase
  let inventory: LocalInventoryRepository
  let sessionId: string
  let productId: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-scan-price-'))
    db = new LocalDatabase(root)
    inventory = new LocalInventoryRepository(db)
    productId = new LocalCatalogRepository(db).upsertProduct({ id: 'scan-price-product', sku: 'SCAN-PRICE', name: 'Fixture', retail_price: 100, qty_on_hand: 8 }).id
    sessionId = inventory.createSession({ name: 'Fixture' }).id
    inventory.startSession(sessionId)
  })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  it('counts a transport replay once, but a fresh scan twice', () => {
    const request = { product_id: productId, operation_id: randomUUID() }
    expect(inventory.scan(sessionId, request).item.counted_stock).toBe(1)
    expect(inventory.scan(sessionId, request).item.counted_stock).toBe(1)
    expect(inventory.scan(sessionId, { ...request, operation_id: randomUUID() }).item.counted_stock).toBe(2)
    expect((db.prepare('SELECT COUNT(*) AS n FROM inventory_count_entries').get() as { n: number }).n).toBe(2)
  })
  it('remembers a scan across database reopen', () => {
    const request = { product_id: productId, operation_id: randomUUID(), qty: 3 }
    inventory.scan(sessionId, request)
    db.close()
    db = new LocalDatabase(root)
    inventory = new LocalInventoryRepository(db)
    expect(inventory.scan(sessionId, request).item.counted_stock).toBe(3)
  })
  it('returns the current count on replay without undoing a manual correction', () => {
    const request = { product_id: productId, operation_id: randomUUID() }
    const { item } = inventory.scan(sessionId, request)
    inventory.setItemQty(sessionId, item.id, { counted_stock: 0 })
    expect(inventory.scan(sessionId, request).item.counted_stock).toBe(0)
  })
  it('does not resurrect a removed row on replay', () => {
    const request = { product_id: productId, operation_id: randomUUID() }
    const { item } = inventory.scan(sessionId, request)
    inventory.removeItem(sessionId, item.id)
    expect(() => inventory.scan(sessionId, request)).toThrow('видалено')
    expect(inventory.getSessionData(sessionId).items).toHaveLength(0)
  })
  it('rejects a different quantity for the same operation ID', () => {
    const request = { product_id: productId, operation_id: randomUUID(), qty: 1 }
    inventory.scan(sessionId, request)
    expect(() => inventory.scan(sessionId, { ...request, qty: 2 })).toThrow('інші дані')
    expect(inventory.getSessionData(sessionId).items[0].counted_stock).toBe(1)
  })
  it('rolls back counting when the scan receipt cannot be saved', () => {
    db.prepare("CREATE TRIGGER fail_scan_receipt BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'inventory-scan:%' BEGIN SELECT RAISE(ABORT, 'receipt failed'); END").run()
    const request = { product_id: productId, operation_id: randomUUID() }
    expect(() => inventory.scan(sessionId, request)).toThrow('receipt failed')
    expect(inventory.getSessionData(sessionId).items).toHaveLength(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM inventory_count_entries').get() as { n: number }).n).toBe(0)
    db.prepare('DROP TRIGGER fail_scan_receipt').run()
    expect(inventory.scan(sessionId, request).item.counted_stock).toBe(1)
  })
  it('does not mark a newly scanned product price as checked', () => {
    expect(inventory.scan(sessionId, { product_id: productId }).item.price_checked).toBe(false)
    expect(inventory.getSessionData(sessionId).summary.price_checked_products).toBe(0)
  })
  it('keeps a recorded price discrepancy when another unit is scanned', () => {
    inventory.countProduct(sessionId, { product_id: productId, qty: 1, price_checked: false, observed_retail_price: 120 })
    const result = inventory.scan(sessionId, { product_id: productId, qty: 2 }).item
    expect(result).toMatchObject({ counted_stock: 3, price_checked: false, observed_retail_price: 120 })
    expect(inventory.getSessionData(sessionId).price_issues).toHaveLength(1)
  })
  it('preserves an explicit previous price check', () => {
    inventory.countProduct(sessionId, { product_id: productId, qty: 1, price_checked: true })
    expect(inventory.scan(sessionId, { product_id: productId }).item.price_checked).toBe(true)
  })
})
