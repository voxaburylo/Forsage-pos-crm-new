import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
import { LocalSyncRepository } from '../src/repositories/syncRepository'

describe('local document synchronization safety', () => {
  let root = ''
  let db: LocalDatabase
  let catalog: LocalCatalogRepository
  let orders: LocalOrderRepository
  let sync: LocalSyncRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-document-sync-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
    orders = new LocalOrderRepository(db)
    sync = new LocalSyncRepository(db)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-document-sync-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function createProduct() {
    return catalog.saveProduct({
      id: randomUUID(),
      sku: `SYNC-${randomUUID().slice(0, 8)}`,
      name: 'Тестовий товар документа',
      qty_on_hand: 10,
      stock_correction: true,
    })
  }

  it('releases an active reserve immediately when a local order is deleted', () => {
    const product = createProduct()
    const order = orders.saveOrder({ manager_id: 'local', items: [] })
    const timestamp = new Date().toISOString()
    const reserveId = randomUUID()
    db.prepare(`
      INSERT INTO stock_reserves (
        id, tenant_id, product_id, order_id, qty, reserved_by,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 2, 'local', ?, ?)
    `).run(reserveId, DEFAULT_TENANT_ID, product.id, order.id, timestamp, timestamp)

    orders.deleteOrder(order.id)

    const reserve = db.prepare('SELECT released_at FROM stock_reserves WHERE id = ?')
      .get(reserveId) as { released_at: string | null }
    expect(reserve.released_at).toBeTruthy()
  })

  it('removes stale clean invoice rows when another device edits the invoice', () => {
    const product = createProduct()
    const invoiceId = randomUUID()
    const oldItemId = randomUUID()
    const newItemId = randomUUID()
    const createdAt = new Date(Date.now() - 10_000).toISOString()

    sync.applyPullChanges({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: new Date(Date.now() - 5_000).toISOString(),
      supply_invoices: [{
        id: invoiceId,
        status: 'draft',
        total: 100,
        created_at: createdAt,
        updated_at: createdAt,
      }],
      supply_invoice_items: [{
        id: oldItemId,
        invoice_id: invoiceId,
        product_id: product.id,
        qty: 1,
        purchase_price: 100,
        total: 100,
        created_at: createdAt,
      }],
    } as any)

    const updatedAt = new Date().toISOString()
    sync.applyPullChanges({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: updatedAt,
      supply_invoices: [{
        id: invoiceId,
        status: 'draft',
        total: 200,
        created_at: createdAt,
        updated_at: updatedAt,
      }],
      supply_invoice_items: [{
        id: newItemId,
        invoice_id: invoiceId,
        product_id: product.id,
        qty: 2,
        purchase_price: 100,
        total: 200,
        created_at: updatedAt,
      }],
    } as any)

    const rows = db.prepare('SELECT id FROM supply_invoice_items WHERE invoice_id = ? ORDER BY id')
      .all(invoiceId) as Array<{ id: string }>
    expect(rows.map((row) => row.id)).toEqual([newItemId])
  })

  it('hides an invoice after receiving its server tombstone', () => {
    const invoiceId = randomUUID()
    const createdAt = new Date().toISOString()
    sync.applyPullChanges({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: createdAt,
      supply_invoices: [{ id: invoiceId, status: 'draft', total: 0, created_at: createdAt, updated_at: createdAt }],
    } as any)

    sync.applyPullChanges({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: new Date().toISOString(),
      deleted_supply_invoice_ids: [invoiceId],
    } as any)

    const invoice = db.prepare('SELECT deleted_at FROM supply_invoices WHERE id = ?')
      .get(invoiceId) as { deleted_at: string | null }
    expect(invoice.deleted_at).toBeTruthy()
  })
})
