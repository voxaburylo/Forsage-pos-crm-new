import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalSyncRepository } from '../src/repositories/syncRepository'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'

describe('chunked desktop pull application', () => {
  let root = ''
  let db: LocalDatabase
  let sync: LocalSyncRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-chunked-pull-'))
    db = new LocalDatabase(root)
    sync = new LocalSyncRepository(db)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-chunked-pull-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the cursor unchanged after a later chunk fails and replays persisted chunks idempotently', async () => {
    const products = Array.from({ length: 101 }, (_, index) => ({
      id: `chunk-product-${index}`,
      sku: `CHUNK-${index}`,
      name: `Chunk product ${index}`,
      qty_on_hand: index,
      retail_price: 100,
    }))
    const broken = [...products]
    broken[100] = { ...broken[100], sku: 'CHUNK-0' }

    await expect(sync.applyPullChangesChunked({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: '2026-08-01T10:00:00.000Z',
      products: broken,
    })).rejects.toThrow()

    expect(sync.getPullState().cursor).toBeNull()
    const afterFailure = db.prepare("SELECT COUNT(*) AS total FROM products WHERE sku LIKE 'CHUNK-%'")
      .get() as { total: number }
    expect(afterFailure.total).toBe(100)

    await sync.applyPullChangesChunked({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: '2026-08-01T10:00:01.000Z',
      products,
    })

    const afterRetry = db.prepare("SELECT COUNT(*) AS total FROM products WHERE sku LIKE 'CHUNK-%'")
      .get() as { total: number }
    expect(afterRetry.total).toBe(101)
    expect(sync.getPullState().cursor).toBe('2026-08-01T10:00:01.000Z')
  })

  it('rolls back a document parent together with an invalid child', async () => {
    await expect(sync.applyPullChangesChunked({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: '2026-08-01T11:00:00.000Z',
      customer_orders: [{ id: 'atomic-order', status: 'lead', total_amount: 100 }],
      customer_order_items: [{
        id: null,
        order_id: 'atomic-order',
        name: 'Invalid row',
        product_id: 'missing-product',
        qty: 1,
        sell_price: 100,
      }],
    } as any)).rejects.toThrow()

    const order = db.prepare('SELECT id FROM customer_orders WHERE id = ?').get('atomic-order')
    expect(order).toBeUndefined()
    expect(sync.getPullState().cursor).toBeNull()
  })
  it('clears obsolete tenant data and outbox before importing a new server generation', async () => {
    const catalog = new LocalCatalogRepository(db)
    const product = catalog.saveProduct({
      id: randomUUID(),
      sku: 'RESET-OLD',
      name: 'Obsolete local product',
      qty_on_hand: 4,
      retail_price: 100,
    })
    db.prepare(`
      INSERT INTO app_meta(key, value_json, updated_at)
      VALUES ('label_designer_test', '{"kept":true}', ?)
    `).run(new Date().toISOString())

    const timestamp = new Date().toISOString()
    const employeeId = randomUUID()
    const shiftId = randomUUID()
    db.prepare(`
      INSERT INTO staff_users (
        id, tenant_id, full_name, role, created_at, updated_at
      ) VALUES (?, ?, 'Reset employee', 'cashier', ?, ?)
    `).run(employeeId, DEFAULT_TENANT_ID, timestamp, timestamp)
    db.prepare(`
      INSERT INTO shifts (
        id, tenant_id, cashier_id, status, opening_cash,
        opened_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'open', 0, ?, ?, ?)
    `).run(shiftId, DEFAULT_TENANT_ID, employeeId, timestamp, timestamp, timestamp)
    db.prepare(`
      INSERT INTO salary_payments (
        id, tenant_id, employee_id, employee_name, amount, type, method,
        period, work_date, source, shift_id, created_at, updated_at
      ) VALUES (?, ?, ?, 'Reset employee', 100, 'salary', 'cash',
        '2026-08', '2026-08-01', 'manual', ?, ?, ?)
    `).run(randomUUID(), DEFAULT_TENANT_ID, employeeId, shiftId, timestamp, timestamp)

    await sync.applyPullChangesChunked({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: '2026-08-01T12:00:00.000Z',
      reset_required: true,
      reset_generation: 3,
      reset_at: '2026-08-01T11:59:59.000Z',
    })

    expect(db.prepare('SELECT id FROM products WHERE id = ?').get(product.id)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS total FROM sync_outbox').get()).toEqual({ total: 0 })
    expect(db.prepare("SELECT value_json FROM app_meta WHERE key = 'device_id'").get()).toBeTruthy()
    expect(db.prepare("SELECT value_json FROM app_meta WHERE key = 'label_designer_test'").get())
      .toEqual({ value_json: '{"kept":true}' })
    expect(sync.getPullState()).toMatchObject({ cursor: null, reset_generation: 3 })

    await sync.applyPullChangesChunked({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: '2026-08-01T12:00:01.000Z',
      reset_generation: 3,
      products: [{
        id: randomUUID(),
        sku: 'RESET-NEW',
        name: 'Fresh server product',
        qty_on_hand: 1,
        retail_price: 200,
      }],
    })

    expect(sync.getPullState()).toMatchObject({
      cursor: '2026-08-01T12:00:01.000Z',
      reset_generation: 3,
    })
    expect(db.prepare("SELECT COUNT(*) AS total FROM products WHERE sku = 'RESET-NEW'").get())
      .toEqual({ total: 1 })
  })

})
