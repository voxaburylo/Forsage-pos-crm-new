import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'

describe('local dashboard summary', () => {
  let root = ''
  let db: LocalDatabase
  let catalog: LocalCatalogRepository
  let orders: LocalOrderRepository
  let pos: LocalPosRepository
  let supply: LocalSupplyRepository
  let cashierId = ''
  let shiftId = ''

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-dashboard-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
    orders = new LocalOrderRepository(db)
    pos = new LocalPosRepository(db)
    supply = new LocalSupplyRepository(db)
    cashierId = randomUUID()
    shiftId = randomUUID()
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO shifts (id, tenant_id, cashier_id, status, opening_cash, opened_at, created_at, updated_at)
      VALUES (?, ?, ?, 'open', 0, ?, ?, ?)
    `).run(shiftId, DEFAULT_TENANT_ID, cashierId, now, now, now)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-dashboard-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('aggregates the full local data set without decorating every sale or order', () => {
    const product = catalog.upsertProduct({
      id: randomUUID(),
      sku: 'DASH-1',
      name: 'Dashboard item',
      qty_on_hand: 10,
      reorder_point: 10,
      purchase_price: 50,
      retail_price: 60,
    })
    const customer = pos.saveCustomer({ phone: '+380501010101', full_name: 'Dashboard customer' }).data
    db.prepare('UPDATE customers SET debt_balance = 375 WHERE id = ?').run(customer.id)
    supply.saveSupplier({ name: 'Dashboard supplier' })
    orders.saveOrder({
      tenant_id: DEFAULT_TENANT_ID,
      manager_id: cashierId,
      items: [{
        name: product.name,
        sku: product.sku,
        product_id: product.id,
        buy_price: 50,
        sell_price: 60,
        qty: 1,
      }],
    })
    pos.checkout({
      cashier_id: cashierId,
      shift_id: shiftId,
      items: [{ product_id: product.id, qty: 2, unit_price: 60 }],
      payments: [{ method: 'cash', amount: 120 }],
    })

    // Legacy receipts created before COGS snapshots contain zero in this field.
    db.prepare('UPDATE sale_items SET purchase_price = 0').run()

    const summary = pos.dashboardSummary({
      date_from: new Date(Date.now() - 60_000).toISOString(),
      date_to: new Date(Date.now() + 60_000).toISOString(),
    })

    expect(summary.analytics).toMatchObject({
      total_revenue: 120,
      cogs: 100,
      gross_profit: 20,
      total_receipts: 1,
      average_receipt: 120,
    })
    expect(summary.analytics.daily).toHaveLength(1)
    expect(summary.totals).toMatchObject({
      products: 1,
      customers: 1,
      suppliers: 1,
      openOrders: 1,
    })
    expect(summary.low_stock).toBe(1)
    expect(summary.debt).toEqual({ count: 1, total: 375 })
    const soldItems = pos.soldItemsReport({
      date_from: new Date(Date.now() - 60_000).toISOString(),
      date_to: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(soldItems).toEqual([
      expect.objectContaining({
        product_id: product.id,
        sku: 'DASH-1',
        name: 'Dashboard item',
        qty_sold: 2,
        qty_returned: 0,
        qty_net: 2,
        revenue: 120,
        net_revenue: 120,
        qty_on_hand: 8,
      }),
    ])
  })
})
