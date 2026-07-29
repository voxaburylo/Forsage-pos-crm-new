import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalInventoryRepository } from '../src/repositories/inventoryRepository'
import { LocalWarehouseRepository } from '../src/repositories/warehouseRepository'

describe('local stock sync safety', () => {
  let root = ''
  let db: LocalDatabase
  let catalog: LocalCatalogRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-stock-sync-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-stock-sync-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function product(qty = 10) {
    return catalog.upsertProduct({
      id: randomUUID(),
      tenant_id: DEFAULT_TENANT_ID,
      sku: `TEST-${randomUUID().slice(0, 8)}`,
      name: 'Тестовий товар',
      qty_on_hand: qty,
      purchase_price: 1000,
      retail_price: 1500,
      is_active: true,
    })
  }

  function outboxTypes(): string[] {
    return (db.prepare('SELECT operation_type FROM sync_outbox ORDER BY sequence').all() as Array<{ operation_type: string }>)
      .map((row) => row.operation_type)
  }

  it('does not let an ordinary product edit overwrite current stock', () => {
    const stored = product(10)

    const saved = catalog.saveProduct({
      id: stored.id,
      sku: stored.sku,
      name: 'Нова назва',
      qty_on_hand: 99,
    })

    expect(saved.qty_on_hand).toBe(10)
    const payload = db.prepare('SELECT payload_json FROM sync_outbox ORDER BY sequence DESC LIMIT 1')
      .get() as { payload_json: string }
    expect(JSON.parse(payload.payload_json)).toMatchObject({ qty_on_hand: 10 })
    expect(JSON.parse(payload.payload_json).stock_correction).not.toBe(true)
  })

  it('allows an explicitly marked stock correction', () => {
    const stored = product(10)

    const saved = catalog.saveProduct({
      id: stored.id,
      sku: stored.sku,
      name: stored.name,
      qty_on_hand: 7,
      stock_correction: true,
    })

    expect(saved.qty_on_hand).toBe(7)
    const payload = db.prepare('SELECT payload_json FROM sync_outbox ORDER BY sequence DESC LIMIT 1')
      .get() as { payload_json: string }
    expect(JSON.parse(payload.payload_json)).toMatchObject({ qty_on_hand: 7, stock_correction: true })
  })

  it('sends inventory completion once without a duplicate product stock snapshot', () => {
    const stored = product(10)
    const inventory = new LocalInventoryRepository(db)
    const session = inventory.createSession({ name: 'Тестова ревізія' })
    inventory.startSession(session.id)
    inventory.countProduct(session.id, { product_id: stored.id, qty: 3 })
    inventory.complete(session.id)

    expect(outboxTypes()).toEqual(['inventory.created', 'inventory.started', 'inventory.completed'])
    expect(outboxTypes()).not.toContain('product.upsert')
    expect(catalog.findById(stored.id)?.qty_on_hand).toBe(3)
  })

  it('sends a writeoff once without a duplicate product stock snapshot', () => {
    const stored = product(10)
    const warehouse = new LocalWarehouseRepository(db)
    warehouse.createWriteoff({ reason: 'other', items: [{ product_id: stored.id, qty: 3 }] })

    expect(outboxTypes()).toEqual(['writeoff.created'])
    expect(catalog.findById(stored.id)?.qty_on_hand).toBe(7)
  })
})