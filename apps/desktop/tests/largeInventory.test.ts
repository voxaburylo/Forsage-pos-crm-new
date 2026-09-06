import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalInventoryRepository } from '../src/repositories/inventoryRepository'

describe('complete large inventory reads', () => {
  let root: string
  let db: LocalDatabase
  let inventory: LocalInventoryRepository
  const size = 10005
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-large-inventory-'))
    db = new LocalDatabase(root)
    inventory = new LocalInventoryRepository(db)
    db.transaction(() => {
      db.prepare(`INSERT INTO inventory_sessions(id, tenant_id, session_name, status, created_at, updated_at)
        VALUES ('session', ?, 'Fixture', 'in_progress', '2026-09-01', '2026-09-01')`).run(tenant)
      const product = db.prepare(`INSERT INTO products(id, tenant_id, sku, name, qty_on_hand, retail_price, created_at, updated_at)
        VALUES (?, ?, ?, 'Fixture', 2, 100, '2026-09-01', '2026-09-01')`)
      const item = db.prepare(`INSERT INTO inventory_items(id, tenant_id, session_id, product_id, expected_stock, counted_stock,
        was_counted, observed_retail_price, created_at, updated_at) VALUES (?, ?, 'session', ?, 2, 3, 1, 120, '2026-09-01', '2026-09-01')`)
      for (let i = 0; i < size; i++) {
        const id = String(i).padStart(5, '0')
        product.run(id, tenant, id)
        item.run(id, tenant, id)
      }
    })
  })
  afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(root, { recursive: true, force: true }) })

  it('returns every counted row and price issue with a bounded number of queries', () => {
    const queries = vi.spyOn(db, 'prepare')
    const session = inventory.getSessionData('session')
    expect(session.items).toHaveLength(size)
    expect(session.price_issues).toHaveLength(size)
    expect(session.summary.counted_products).toBe(size)
    expect(queries.mock.calls.length).toBeLessThan(12)
    expect(session.items[0].product).toMatchObject({ name: 'Fixture', retail_price: 100, qty_on_hand: 2 })
  })
  it('includes labels beyond ten thousand and excludes zero counts', () => {
    db.prepare("UPDATE inventory_items SET counted_stock = 0 WHERE id = '00000'").run()
    expect(inventory.getLabels('session')).toHaveLength(size - 1)
  })
  it('counts actual price differences, not every observed price', () => {
    db.prepare('UPDATE inventory_items SET observed_retail_price = 100').run()
    const session = inventory.getSessionData('session')
    expect(session.price_issues).toHaveLength(0)
    expect(session.summary.price_mismatch_products).toBe(0)
  })
  it('does not hide a deleted product row or allow partial completion', () => {
    db.prepare("UPDATE products SET deleted_at = '2026-09-06' WHERE id = '00000'").run()
    expect(inventory.getSessionData('session').items.find((item: any) => item.id === '00000').product).toBeNull()
    expect(() => inventory.complete('session')).toThrow(/видален/)
    expect(db.prepare('SELECT COUNT(*) n FROM products WHERE qty_on_hand <> 2').get()).toEqual({ n: 0 })
  }, 20000)
  it('completes every counted row and includes all rows in the outbox', () => {
    expect(inventory.complete('session')).toEqual({ items_updated: size })
    expect(db.prepare('SELECT COUNT(*) n FROM products WHERE qty_on_hand = 3').get()).toEqual({ n: size })
    const operation = db.prepare("SELECT payload_json FROM sync_outbox WHERE operation_type = 'inventory.completed'").get() as { payload_json: string }
    expect(JSON.parse(operation.payload_json).items).toHaveLength(size)
  }, 20000)
})
