import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalInventoryRepository } from '../src/repositories/inventoryRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'

describe('inventory and trading between count and completion', () => {
  let root: string, db: LocalDatabase, inventory: LocalInventoryRepository
  let catalog: LocalCatalogRepository, pos: LocalPosRepository
  let productId: string, sessionId: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-count-conflict-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
    inventory = new LocalInventoryRepository(db)
    pos = new LocalPosRepository(db)
    productId = catalog.upsertProduct({ id: 'part', sku: 'PART', name: 'Part', qty_on_hand: 10, retail_price: 100 }).id
    sessionId = inventory.createSession({ name: 'Count' }).id
    inventory.startSession(sessionId)
    inventory.countProduct(sessionId, { product_id: productId, qty: 10 })
    db.prepare(`INSERT INTO shifts(id, tenant_id, cashier_id, status, opening_cash, opened_at, created_at, updated_at)
      VALUES ('shift', ?, 'cashier', 'open', 0, '2026-09-09', '2026-09-09', '2026-09-09')`).run(tenant)
  })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  function sell() {
    pos.checkout({ cashier_id: 'cashier', shift_id: 'shift', items: [{ product_id: productId, qty: 1, unit_price: 100 }], payments: [{ method: 'cash', amount: 100 }] })
  }
  it('does not restore a sold unit when completing an older count', () => {
    sell()
    expect(() => inventory.complete(sessionId)).toThrow(/перерах/i)
    expect(catalog.findById(productId)?.qty_on_hand).toBe(9)
    expect(inventory.getSessionData(sessionId).status).toBe('in_progress')
  })
  it('permits explicit recount after trading and preserves that checkpoint across restart', () => {
    sell()
    const item = inventory.getSessionData(sessionId).items[0]
    inventory.setItemQty(sessionId, item.id, { counted_stock: 9 })
    db.close()
    db = new LocalDatabase(root)
    inventory = new LocalInventoryRepository(db)
    expect(inventory.complete(sessionId)).toEqual({ items_updated: 1 })
    expect(db.prepare('SELECT qty_on_hand qty FROM products WHERE id = ?').get(productId)).toEqual({ qty: 9 })
  })
  it('detects intervening movements even when the net quantity returns to its old value', () => {
    sell()
    db.prepare('UPDATE products SET qty_on_hand = 10 WHERE id = ?').run(productId)
    expect(() => inventory.complete(sessionId)).toThrow(/перерах/i)
  })
})
