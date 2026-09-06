import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalInventoryRepository } from '../src/repositories/inventoryRepository'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'

describe('atomic inventory product creation', () => {
  it('allows receiving staff but denies read-only and tire workers', () => {
    expect(isDesktopChannelAllowed('desktop:inventory:create-product', 'cashier')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:inventory:create-product', 'manager')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:inventory:create-product', 'sto_viewer')).toBe(false)
    expect(isDesktopChannelAllowed('desktop:inventory:create-product', 'tire_worker')).toBe(false)
  })
  let root: string
  let db: LocalDatabase
  let inventory: LocalInventoryRepository
  let sessionId: string
  let operationId: string
  const request = () => ({ operation_id: operationId, product: { id: operationId, sku: 'NEW-REV', name: 'Fixture', retail_price: 100, qty_on_hand: 99 }, qty: 8 })
  const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-inventory-create-'))
    db = new LocalDatabase(root)
    new LocalCatalogRepository(db)
    inventory = new LocalInventoryRepository(db)
    sessionId = inventory.createSession({ name: 'Fixture' }).id
    inventory.startSession(sessionId)
    operationId = randomUUID()
  })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  it('creates one card and one count without applying stock early', () => {
    inventory.createAndCountProduct(sessionId, request())
    expect(inventory.getSessionData(sessionId).items[0].counted_stock).toBe(8)
    expect(new LocalCatalogRepository(db).findById(operationId)?.qty_on_hand).toBe(0)
    expect(count('inventory_count_entries')).toBe(1)
  })
  it('replays after a lost response and process restart without adding again', () => {
    inventory.createAndCountProduct(sessionId, request())
    const outbox = count('sync_outbox')
    db.close()
    db = new LocalDatabase(root)
    inventory = new LocalInventoryRepository(db)
    const result = inventory.createAndCountProduct(sessionId, request())
    expect(result.session.items[0].counted_stock).toBe(8)
    expect(count('inventory_count_entries')).toBe(1)
    expect(count('sync_outbox')).toBe(outbox)
  })
  it('rolls back card, outbox and count if counting fails', () => {
    const outbox = count('sync_outbox')
    db.prepare("CREATE TRIGGER fail_inventory_count BEFORE INSERT ON inventory_count_entries BEGIN SELECT RAISE(ABORT, 'injected count failure'); END").run()
    expect(() => inventory.createAndCountProduct(sessionId, request())).toThrow('injected count failure')
    expect(count('products')).toBe(0)
    expect(count('inventory_items')).toBe(0)
    expect(count('sync_outbox')).toBe(outbox)
    db.prepare('DROP TRIGGER fail_inventory_count').run()
    expect(inventory.createAndCountProduct(sessionId, request()).session.items[0].counted_stock).toBe(8)
  })
  it('rolls back everything if saving the durable receipt fails', () => {
    const outbox = count('sync_outbox')
    db.prepare("CREATE TRIGGER fail_receipt BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'inventory-create:%' BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END").run()
    expect(() => inventory.createAndCountProduct(sessionId, request())).toThrow('injected receipt failure')
    expect(count('products')).toBe(0)
    expect(count('inventory_items')).toBe(0)
    expect(count('inventory_count_entries')).toBe(0)
    expect(count('sync_outbox')).toBe(outbox)
  })
  it('rejects changed retry payload rather than adding new quantity', () => {
    inventory.createAndCountProduct(sessionId, request())
    expect(() => inventory.createAndCountProduct(sessionId, { ...request(), qty: 9 })).toThrow('повтор')
    expect(inventory.getSessionData(sessionId).items[0].counted_stock).toBe(8)
  })
  it('rejects a closed revision without creating a card', () => {
    db.prepare("UPDATE inventory_sessions SET status = 'completed' WHERE id = ?").run(sessionId)
    expect(() => inventory.createAndCountProduct(sessionId, request())).toThrow()
    expect(count('products')).toBe(0)
  })
  it('does not overwrite an existing card or create a duplicate SKU', () => {
    new LocalCatalogRepository(db).saveProduct({ id: randomUUID(), sku: 'NEW-REV', name: 'Existing', retail_price: 500, qty_on_hand: 3 })
    expect(() => inventory.createAndCountProduct(sessionId, request())).toThrow('вже існує')
    expect(count('products')).toBe(1)
    expect(count('inventory_items')).toBe(0)
  })
})
