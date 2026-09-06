import { mkdtempSync, rmSync } from 'node:fs'
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
