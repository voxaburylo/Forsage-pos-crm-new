import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalBootstrapRepository } from '../src/repositories/bootstrapRepository'


describe('server sale import stock ledger repair', () => {
  let root = ''
  let db: LocalDatabase

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-bootstrap-sale-'))
    db = new LocalDatabase(root)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-bootstrap-sale-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates one sale movement for a pulled sale without changing the canonical stock snapshot', () => {
    const productId = randomUUID()
    const shiftId = randomUUID()
    const saleId = randomUUID()
    const itemId = randomUUID()
    const timestamp = new Date().toISOString()
    const changes: any = {
      tenant_id: DEFAULT_TENANT_ID,
      cursor: timestamp,
      products: [{
        id: productId,
        tenant_id: DEFAULT_TENANT_ID,
        sku: 'REMOTE-SALE-1',
        name: 'Remote sale product',
        qty_on_hand: 7,
        purchase_price: 50,
        retail_price: 100,
        unit: 'шт',
        is_active: true,
        is_service: false,
        created_at: timestamp,
        updated_at: timestamp,
      }],
      shifts: [{
        id: shiftId,
        tenant_id: DEFAULT_TENANT_ID,
        cashier_id: randomUUID(),
        status: 'open',
        opening_cash: 0,
        opened_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      }],
      sales: [{
        id: saleId,
        tenant_id: DEFAULT_TENANT_ID,
        sale_number: 'REMOTE-0001',
        shift_id: shiftId,
        cashier_id: randomUUID(),
        status: 'completed',
        subtotal: 300,
        total: 300,
        payment_method: 'cash',
        completed_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      }],
      sale_items: [{
        id: itemId,
        tenant_id: DEFAULT_TENANT_ID,
        sale_id: saleId,
        product_id: productId,
        qty: 3,
        unit_price: 100,
        purchase_price: 50,
        total: 300,
        description: 'Remote sale product',
        sku: 'REMOTE-SALE-1',
        created_at: timestamp,
        updated_at: timestamp,
      }],
    }

    const importer = new LocalBootstrapRepository(db)
    importer.applySyncChanges(DEFAULT_TENANT_ID, changes)
    importer.applySyncChanges(DEFAULT_TENANT_ID, changes)

    expect((db.prepare('SELECT qty_on_hand FROM products WHERE id = ?').get(productId) as { qty_on_hand: number }).qty_on_hand)
      .toBe(7)
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM inventory_movements
      WHERE source_type = 'sale' AND source_id = ? AND product_id = ?
    `).get(saleId, productId)).toEqual({ count: 1 })
    expect(db.prepare(`
      SELECT qty_delta, qty_after, dirty_at
      FROM inventory_movements
      WHERE source_type = 'sale' AND source_id = ? AND product_id = ?
    `).get(saleId, productId)).toEqual({ qty_delta: -3, qty_after: 7, dirty_at: null })
  })
})