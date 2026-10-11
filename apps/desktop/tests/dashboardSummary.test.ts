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

    // Later catalogue prices must not rewrite historical cost snapshots.
    db.prepare('UPDATE products SET purchase_price = 999').run()

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

  it('enriches net sales with all historical suppliers without multiplying sales or writing stock', () => {
    const product = catalog.upsertProduct({ id: randomUUID(), sku: 'SUP-REPORT', name: 'Supplier report', qty_on_hand: 10, purchase_price: 50, retail_price: 100 })
    const a = supply.saveSupplier({ name: 'Автокомфорт' })
    const b = supply.saveSupplier({ name: 'Інший' })
    for (const supplier of [a, a, b]) {
      const invoice = supply.createInvoice({ supplier_id: supplier.id, items: [{ product_id: product.id, qty: 2, purchase_price: 50 }] })
      supply.postInvoice(invoice.id)
      db.prepare("UPDATE supply_invoices SET posted_at = '2020-01-01T12:00:00Z' WHERE id = ?").run(invoice.id)
    }
    const sale = pos.checkout({ cashier_id: cashierId, shift_id: shiftId,
      items: [{ product_id: product.id, qty: 2, unit_price: 100 }], payments: [{ method: 'cash', amount: 200 }] })
    const line = pos.getSaleForReturn(sale.sale_id).items[0]
    pos.createReturn({ sale_id: sale.sale_id, approved_by: cashierId, shift_id: shiftId, reason: 'other', refund_method: 'cash', stock_action: 'return_to_stock',
      items: [{ sale_item_id: line.id, product_id: product.id, quantity: 1, condition: 'good' }] })
    const before = db.prepare('SELECT qty_on_hand FROM products WHERE id = ?').get(product.id)
    const rows = pos.soldItemsReport({ date_from: new Date(Date.now() - 60_000).toISOString(), date_to: new Date(Date.now() + 60_000).toISOString() })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ qty_sold: 2, qty_returned: 1, qty_net: 1, net_revenue: 100, suppliers: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }] })
    expect(db.prepare('SELECT qty_on_hand FROM products WHERE id = ?').get(product.id)).toEqual(before)
  })

  it('deducts full returns in their own period without inventing expenses', () => {
    const product = catalog.upsertProduct({ id: randomUUID(), sku: 'RETURN', name: 'Return', qty_on_hand: 4, purchase_price: 40, retail_price: 100 })
    const sale = pos.checkout({ cashier_id: cashierId, shift_id: shiftId,
      items: [{ product_id: product.id, qty: 2, unit_price: 100 }], payments: [{ method: 'cash', amount: 200 }] })
    const item = pos.getSaleForReturn(sale.sale_id).items[0]
    const payload = { sale_id: sale.sale_id, approved_by: cashierId, shift_id: shiftId, reason: 'other', refund_method: 'cash', stock_action: 'return_to_stock',
      items: [{ sale_item_id: item.id, product_id: product.id, quantity: 2, condition: 'good' }] }
    db.prepare(`UPDATE products SET is_active = 0 WHERE id = ?`).run(product.id)
    expect(() => pos.createReturn(payload)).toThrow(/неактивний/)
    expect(db.prepare('SELECT COUNT(*) n FROM customer_returns').get()).toEqual({ n: 0 })
    db.prepare(`UPDATE products SET is_active = 1 WHERE id = ?`).run(product.id)
    pos.createReturn(payload)
    const range = { date_from: new Date(Date.now() - 60_000).toISOString(), date_to: new Date(Date.now() + 60_000).toISOString() }
    expect(pos.dashboardSummary(range).analytics).toMatchObject({ total_revenue: 0, cogs: 0, gross_profit: 0, refund_total: 200, expenses: null, net_profit: null })
    db.prepare(`UPDATE sales SET completed_at = '2020-01-01T12:00:00.000Z' WHERE id = ?`).run(sale.sale_id)
    expect(pos.dashboardSummary(range).analytics).toMatchObject({ total_revenue: -200, cogs: -80, gross_profit: -120 })
  })

  it.each(['missing-lines', 'archived-lines', 'zero-qty', 'negative-cost', 'uncovered-total', 'negative-line-total', 'fractional-revenue'])(
    'rejects an incomplete receipt rather than inventing a dashboard profit: %s', fault => {
      const product = catalog.upsertProduct({ id: randomUUID(), sku: 'DAMAGED', name: 'Damaged receipt fixture', qty_on_hand: 4, purchase_price: 40, retail_price: 100 })
      const sale = pos.checkout({ cashier_id: cashierId, shift_id: shiftId,
        items: [{ product_id: product.id, qty: 1, unit_price: 100 }], payments: [{ method: 'cash', amount: 100 }] })
      if (fault === 'missing-lines') db.prepare('DELETE FROM sale_items WHERE sale_id=?').run(sale.sale_id)
      if (fault === 'archived-lines') db.prepare('UPDATE sale_items SET deleted_at=? WHERE sale_id=?').run(new Date().toISOString(), sale.sale_id)
      if (fault === 'zero-qty') db.prepare('UPDATE sale_items SET qty=0 WHERE sale_id=?').run(sale.sale_id)
      if (fault === 'negative-cost') db.prepare('UPDATE sale_items SET purchase_price=-1 WHERE sale_id=?').run(sale.sale_id)
      if (fault === 'uncovered-total') db.prepare('UPDATE sale_items SET total=50 WHERE sale_id=?').run(sale.sale_id)
      if (fault === 'negative-line-total') db.prepare('UPDATE sale_items SET total=-1 WHERE sale_id=?').run(sale.sale_id)
      if (fault === 'fractional-revenue') db.prepare('UPDATE sales SET total=99.5 WHERE id=?').run(sale.sale_id)
      db.prepare('PRAGMA query_only=ON').run()
      const range = { date_from: new Date(Date.now() - 60_000).toISOString(), date_to: new Date(Date.now() + 60_000).toISOString() }
      expect(() => pos.dashboardSummary(range)).toThrow(/неповні або не узгоджені/)
      // A bad historic receipt outside the requested period does not block today's valid zero report.
      const after = new Date(Date.now() + 120_000).toISOString()
      expect(pos.dashboardSummary({ date_from: after, date_to: after }).analytics.total_revenue).toBe(0)
    })

  it.each(['missing-lines', 'mismatched-total', 'wrong-original-sale', 'wrong-product', 'zero-quantity', 'negative-cost'])(
    'rejects an incomplete return of an older receipt: %s', fault => {
      const product = catalog.upsertProduct({ id: randomUUID(), sku: 'DAMAGED-RETURN', name: 'Return fixture', qty_on_hand: 4, purchase_price: 40, retail_price: 100 })
      const sale = pos.checkout({ cashier_id: cashierId, shift_id: shiftId,
        items: [{ product_id: product.id, qty: 1, unit_price: 100 }], payments: [{ method: 'cash', amount: 100 }] })
      const item = pos.getSaleForReturn(sale.sale_id).items[0]
      const result = pos.createReturn({ sale_id: sale.sale_id, approved_by: cashierId, shift_id: shiftId,
        refund_method: 'cash', stock_action: 'return_to_stock',
        items: [{ sale_item_id: item.id, product_id: product.id, quantity: 1 }] })
      db.prepare("UPDATE sales SET completed_at='2020-01-01T12:00:00.000Z' WHERE id=?").run(sale.sale_id)
      if (fault === 'missing-lines') db.prepare('DELETE FROM customer_return_items WHERE return_id=?').run(result.id)
      if (fault === 'mismatched-total') db.prepare('UPDATE customer_returns SET refund_kopecks=99 WHERE id=?').run(result.id)
      if (fault === 'wrong-original-sale') {
        const otherSale = pos.checkout({ cashier_id: cashierId, shift_id: shiftId,
          items: [{ product_id: product.id, qty: 1, unit_price: 100 }], payments: [{ method: 'cash', amount: 100 }] })
        db.prepare('UPDATE customer_returns SET sale_id=? WHERE id=?').run(otherSale.sale_id, result.id)
      }
      if (fault === 'wrong-product') {
        const other = catalog.upsertProduct({ id: randomUUID(), sku: 'OTHER', name: 'Other product', qty_on_hand: 1, purchase_price: 40, retail_price: 100 })
        db.prepare('UPDATE customer_return_items SET product_id=? WHERE return_id=?').run(other.id, result.id)
      }
      if (fault === 'zero-quantity') db.prepare('UPDATE customer_return_items SET quantity=0 WHERE return_id=?').run(result.id)
      if (fault === 'negative-cost') db.prepare('UPDATE sale_items SET purchase_price=-1 WHERE id=?').run(item.id)
      db.prepare('PRAGMA query_only=ON').run()
      const range = { date_from: new Date(Date.now() - 60_000).toISOString(), date_to: new Date(Date.now() + 60_000).toISOString() }
      expect(() => pos.dashboardSummary(range)).toThrow(/неповні або не узгоджені/)
    })
})
