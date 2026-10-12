import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalBootstrapRepository } from '../src/repositories/bootstrapRepository'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosReports } from '../src/repositories/pos/reports'

describe('historical receipt lines for archived products', () => {
  let root: string, db: LocalDatabase
  const at = '2026-07-01T10:00:00.000Z', deletedAt = '2026-09-06T11:13:00.000Z'
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-archived-receipt-')); db = new LocalDatabase(root) })
  afterEach(() => {
    db.close()
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()))
    expect(realpathSync(root)).toBe(root)
    expect(path.basename(root).startsWith('forsage-archived-receipt-')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })
  function fixture(archived = true): any {
    const productId = randomUUID(), saleId = randomUUID(), shiftId = randomUUID()
    return { tenant_id: tenant, cursor: '2026-10-13T00:00:00.000Z', exported_at: '2026-10-13T00:00:00.000Z',
      products: [{ id: productId, sku: 'HISTORY-1', name: 'Archived original item', qty_on_hand: 4,
        purchase_price: 9900, retail_price: 18000, unit: 'шт', is_active: true, is_service: false,
        created_at: at, updated_at: deletedAt, deleted_at: archived ? deletedAt : null }],
      shifts: [{ id: shiftId, cashier_id: randomUUID(), status: 'closed', opening_cash: 0, opened_at: at, created_at: at, updated_at: at }],
      sales: [{ id: saleId, sale_number: 'HISTORY-01', shift_id: shiftId, cashier_id: randomUUID(),
        status: 'completed', subtotal: 15000, total: 15000, cash_amount: 15000, payment_method: 'cash',
        completed_at: at, created_at: at, updated_at: at }],
      sale_items: [{ id: randomUUID(), sale_id: saleId, product_id: productId, qty: 1,
        unit_price: 15000, cost_price: 10000, discount: 0, total: 15000, created_at: at }],
    }
  }
  it.each(['delta', 'snapshot'])('%s retains the archived item and historical cost, without replaying the sale or restoring search visibility', mode => {
    const input = fixture(), importer = new LocalBootstrapRepository(db)
    const apply = () => mode === 'snapshot' ? importer.importSnapshot(input) : importer.applySyncChanges(tenant, input)
    apply()
    apply()
    expect(db.prepare('SELECT product_id,qty,purchase_price,total FROM sale_items').all()).toEqual([
      { product_id: input.products[0].id, qty: 1, purchase_price: 10000, total: 15000 },
    ])
    expect(db.prepare('SELECT qty_on_hand,deleted_at FROM products').get()).toEqual({ qty_on_hand: 4, deleted_at: deletedAt })
    expect(new LocalCatalogRepository(db).searchProducts('HISTORY-1')).toEqual([])
    expect(db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE source_type='sale'").get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) n FROM sync_outbox').get()).toEqual({ n: 0 })
    const report = new LocalPosReports(db).salesPeriodReport({ date_from: at, date_to: at })
    expect(report).toMatchObject({ net_revenue: 15000, profit: 5000, total_sales: 1 })
  })
  it('uses an already archived local card when a delta contains only its receipt', () => {
    const input = fixture(), importer = new LocalBootstrapRepository(db)
    importer.applySyncChanges(tenant, { ...input, sales: [], sale_items: [] })
    const before = db.prepare('SELECT * FROM products').all()
    importer.applySyncChanges(tenant, { ...input, products: [] })
    expect(db.prepare('SELECT id FROM sale_items').all()).toEqual([{ id: input.sale_items[0].id }])
    expect(db.prepare('SELECT * FROM products').all()).toEqual(before)
  })
  it.each(['delta', 'snapshot'])('%s does not acknowledge a partial import when a referenced product is absent', mode => {
    const input = { ...fixture(), products: [] }, importer = new LocalBootstrapRepository(db)
    expect(() => mode === 'snapshot' ? importer.importSnapshot(input) : importer.applySyncChanges(tenant, input))
      .toThrow(/відсутн.*товар|товар.*відсутн/i)
    expect(db.prepare('SELECT COUNT(*) n FROM sales').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) n FROM shifts').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) n FROM sync_state').get()).toEqual({ n: 0 })
  })
  it('still preserves locally edited receipts and does not import a conflicting missing reference', () => {
    const input = fixture(), importer = new LocalBootstrapRepository(db)
    importer.applySyncChanges(tenant, { ...input, sale_items: [] })
    db.prepare('UPDATE sales SET dirty_at=?').run(deletedAt)
    expect(() => importer.applySyncChanges(tenant, { ...input, products: [],
      sale_items: [{ ...input.sale_items[0], product_id: randomUUID() }] })).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) n FROM sale_items').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT dirty_at FROM sales').get()).toEqual({ dirty_at: deletedAt })
  })
  it.each(['delta', 'snapshot'])('%s keeps counted historical inventory rows for the same archived card', mode => {
    const input = fixture(), sessionId = randomUUID()
    input.inventory_sessions = [{ id: sessionId, name: 'Historic count', status: 'completed',
      created_at: at, updated_at: at, completed_at: at }]
    input.inventory_items = [{ id: randomUUID(), session_id: sessionId, product_id: input.products[0].id,
      expected_stock: 9, counted_stock: 4, was_counted: true, created_at: at, updated_at: at }]
    const importer = new LocalBootstrapRepository(db)
    if (mode === 'snapshot') importer.importSnapshot(input)
    else importer.applySyncChanges(tenant, input)
    expect(db.prepare('SELECT product_id,expected_stock,counted_stock,was_counted FROM inventory_items').all())
      .toEqual([{ product_id: input.products[0].id, expected_stock: 9, counted_stock: 4, was_counted: 1 }])
    expect(db.prepare('SELECT qty_on_hand,deleted_at FROM products').get()).toEqual({ qty_on_hand: 4, deleted_at: deletedAt })
    expect(db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE source_type='inventory'").get()).toEqual({ n: 0 })
  })
  it.each(['delta', 'snapshot'])('%s preserves an explicitly unlinked free-price line without creating a product', mode => {
    const input = fixture(), importer = new LocalBootstrapRepository(db)
    input.products = []
    input.sale_items = [{ ...input.sale_items[0], product_id: null, description: 'Послуга без картки', sku: null, cost_price: 0 }]
    if (mode === 'snapshot') importer.importSnapshot(input)
    else importer.applySyncChanges(tenant, input)
    expect(db.prepare('SELECT product_id,description,sku,purchase_price,total FROM sale_items').get())
      .toEqual({ product_id: null, description: 'Послуга без картки', sku: null, purchase_price: 0, total: 15000 })
    expect(db.prepare('SELECT COUNT(*) n FROM products').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) n FROM inventory_movements').get()).toEqual({ n: 0 })
  })
})
