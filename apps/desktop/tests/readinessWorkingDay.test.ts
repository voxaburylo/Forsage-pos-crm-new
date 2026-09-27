import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalInventoryRepository } from '../src/repositories/inventoryRepository'
import { LocalWarehouseRepository } from '../src/repositories/warehouseRepository'
import { LocalOrderRepository } from '../src/repositories/orderRepository'

describe('readiness: complete working day on synthetic data', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository
  let cashier: string, shift: string
  const period = { date_from: '2020-01-01T00:00:00.000Z', date_to: '2099-12-31T23:59:59.999Z' }
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-readiness-day-'))
    db = new LocalDatabase(root)
    pos = new LocalPosRepository(db)
    cashier = randomUUID()
    shift = pos.openShift({ cashier_id: cashier, opening_cash: 100000 })
  })
  afterEach(() => {
    db.close()
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-readiness-day-')) rmSync(root, { recursive: true, force: true })
  })
  function restart() { db.close(); db = new LocalDatabase(root); pos = new LocalPosRepository(db) }

  it('receiving → mixed discounted sale → return → inventory → writeoff → debt → close → restore', async () => {
    const catalog = new LocalCatalogRepository(db), supply = new LocalSupplyRepository(db)
    const product = catalog.saveProduct({ id: randomUUID(), sku: 'READY-1', name: 'Тестовий фільтр', qty_on_hand: 0, purchase_price: 1000, retail_price: 5000 })
    const supplier = supply.saveSupplier({ name: 'Тестовий постачальник' })
    const invoice = supply.createInvoice({ supplier_id: supplier.id, items: [{ product_id: product.id, qty: 46, purchase_price: 1000 }] })
    supply.updateInvoice(invoice.id, { items: [{ product_id: product.id, qty: 98, purchase_price: 1000 }] })
    expect(supply.postInvoice(invoice.id).total).toBe(98000)
    expect(catalog.findById(product.id)?.qty_on_hand).toBe(98)
    const payment = { payment_id: randomUUID(), amount: 30000, payment_method: 'cash' as const, fund_source: 'cashbox' as const, shift_id: shift, user_id: cashier }
    supply.payInvoice(invoice.id, payment)
    supply.payInvoice(invoice.id, { ...payment, payment_id: randomUUID(), amount: 68000, fund_source: 'owner_funds' })
    expect(supply.payInvoice(invoice.id, payment).paid_amount).toBe(98000)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(70000)

    const request = { client_operation_id: randomUUID(), cashier_id: cashier, shift_id: shift,
      items: [{ product_id: product.id, qty: 3, unit_price: 5000 }], discount: 1500,
      payments: [{ method: 'cash' as const, amount: 5000 }, { method: 'card' as const, amount: 8500 }] }
    const sale = pos.checkout(request)
    expect(pos.checkout(request).sale_id).toBe(sale.sale_id)
    expect(catalog.findById(product.id)?.qty_on_hand).toBe(95)
    const item = pos.getSaleForReturn(sale.sale_id).items[0]
    const returned = pos.createReturn({ client_operation_id: randomUUID(), sale_id: sale.sale_id,
      approved_by: cashier, shift_id: shift, refund_method: 'cash', stock_action: 'return_to_stock',
      items: [{ sale_item_id: item.id, product_id: product.id, quantity: 1 }] })
    expect(returned.refund_kopecks).toBe(4500)
    expect(catalog.findById(product.id)?.qty_on_hand).toBe(96)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(70500)

    const inventory = new LocalInventoryRepository(db)
    const revision = inventory.createSession({ name: 'Контрольна ревізія', created_by: cashier })
    inventory.startSession(revision.id)
    const counted = inventory.countProduct(revision.id, { product_id: product.id, user_id: cashier, qty: 94, price_checked: true })
    inventory.setItemQty(revision.id, counted.data.item_id, { counted_stock: 94 })
    inventory.complete(revision.id)
    new LocalWarehouseRepository(db).createWriteoff({ reason: 'damage', user_id: cashier, items: [{ product_id: product.id, qty: 2 }] })
    expect(catalog.findById(product.id)?.qty_on_hand).toBe(92)

    const customer = pos.saveCustomer({ full_name: 'Тестовий клієнт', phone: '0500000020' }).data.id
    pos.checkout({ cashier_id: cashier, shift_id: shift, customer_id: customer,
      items: [{ product_id: product.id, qty: 2, unit_price: 5000 }],
      payments: [{ method: 'cash', amount: 4000 }, { method: 'debt', amount: 6000 }] })
    expect(pos.getCustomer(customer).debt_balance).toBe(6000)
    const debt = { operation_id: randomUUID(), customer_id: customer, amount: 6000, method: 'card' as const, shift_id: shift, user_id: cashier }
    pos.payDebt(debt)
    restart()
    pos.payDebt(debt)
    expect(pos.getCustomer(customer).debt_balance).toBe(0)
    expect(new LocalCatalogRepository(db).findById(product.id)?.qty_on_hand).toBe(90)
    expect(db.prepare('SELECT SUM(qty_delta) qty FROM inventory_movements WHERE product_id=?').get(product.id)).toEqual({ qty: 90 })
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(74500)
    expect(pos.dashboardSummary(period).analytics).toMatchObject({ total_revenue: 19000, cogs: 4000, gross_profit: 15000 })
    expect(pos.soldItemsReport(period)).toEqual([expect.objectContaining({ product_id: product.id, qty_sold: 5, qty_returned: 1, qty_net: 4, net_revenue: 19000 })])
    pos.closeShift(cashier, 74500, null, shift)
    expect(pos.getOpenShift(cashier)).toBeNull()

    const tables = ['products', 'sales', 'sale_items', 'sale_payments', 'supply_invoices', 'supply_invoice_items', 'supplier_payments', 'customer_returns', 'inventory_movements', 'customers', 'cash_operations', 'shifts', 'sync_outbox']
    const snapshot = () => Object.fromEntries(tables.map((table) => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]))
    const before = snapshot(), backup = await db.backupNow()
    db.prepare('UPDATE products SET qty_on_hand=999').run()
    db.close()
    LocalDatabase.stageBackupForRestart(root, path.basename(backup))
    db = new LocalDatabase(root); pos = new LocalPosRepository(db)
    expect(snapshot()).toEqual(before)
    expect(pos.checkout(request).sale_id).toBe(sale.sale_id)
    expect(snapshot()).toEqual(before)
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  })

  it('excludes services only after allocating receipt and item discounts', () => {
    const catalog = new LocalCatalogRepository(db)
    const goods = catalog.saveProduct({ id: randomUUID(), sku: 'DISCOUNT-GOODS', name: 'Тестовий товар', qty_on_hand: 5, retail_price: 10000 })
    const service = catalog.saveProduct({ id: randomUUID(), sku: 'DISCOUNT-SERVICE', name: 'Тестова послуга', is_service: true, retail_price: 10000 })
    pos.checkout({ cashier_id: cashier, shift_id: shift, discount: 1900,
      items: [{ product_id: goods.id, qty: 1, unit_price: 10000, discount: 1000 }, { product_id: service.id, qty: 1, unit_price: 10000 }],
      payments: [{ method: 'cash', amount: 17100 }] })
    expect(pos.soldItemsReport(period)).toEqual([expect.objectContaining({ product_id: goods.id, qty_net: 1, revenue: 8100, net_revenue: 8100 })])
  })

  it('keeps the core deposit separate when a discounted product is returned', () => {
    const catalog = new LocalCatalogRepository(db)
    const core = catalog.saveProduct({ id: randomUUID(), sku: 'CORE-A', name: 'Test core', qty_on_hand: 2, retail_price: 100, requires_core_return: true, core_deposit_amount: 100 })
    const other = catalog.saveProduct({ id: randomUUID(), sku: 'CORE-B', name: 'Test other', qty_on_hand: 2, retail_price: 100 })
    const sale = pos.checkout({ cashier_id: cashier, shift_id: shift, discount: 30,
      items: [{ product_id: core.id, qty: 1, unit_price: 100 }, { product_id: other.id, qty: 1, unit_price: 100 }],
      payments: [{ method: 'cash', amount: 270 }] })
    const item = pos.getSaleForReturn(sale.sale_id).items.find((row: any) => row.product_id === core.id)!
    expect(pos.createReturn({ sale_id: sale.sale_id, shift_id: shift, approved_by: cashier,
      items: [{ sale_item_id: item.id, product_id: core.id, quantity: 1 }] }).refund_kopecks).toBe(85)
    const report = pos.soldItemsReport(period)
    expect(report.find(row => row.product_id === core.id)).toMatchObject({ revenue: 185, refund_total: 85, net_revenue: 100 })
    expect(report.find(row => row.product_id === other.id)).toMatchObject({ revenue: 85, net_revenue: 85 })
  })

  it('manager cancels a prepaid order; cashier pays out once after restart', () => {
    const customer = pos.saveCustomer({ full_name: 'Клієнт замовлення', phone: '0500000021' }).data.id
    let orders = new LocalOrderRepository(db)
    const order = orders.saveOrder({ customer_id: customer, manager_id: 'test-manager', items: [{ name: 'Замовна деталь', sku: 'READY-ORDER', sell_price: 15000, buy_price: 10000, qty: 1 }] })
    const prepayment = { payment_id: randomUUID(), user_id: cashier, shift_id: shift, amount: 5000, method: 'cash' as const, is_fiscal: false }
    orders.addPayment(order.id, prepayment)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(105000)
    orders.cancelOrder(order.id, { keep_as_credit: true, user_id: 'test-manager' })
    expect(pos.getCustomerDeposit(customer).balance).toBe(5000)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(105000)
    restart(); orders = new LocalOrderRepository(db)
    orders.cancelOrder(order.id, { keep_as_credit: true, user_id: 'test-manager' })
    expect(pos.getCustomerDeposit(customer).balance).toBe(5000)
    const payout = { payout_id: randomUUID(), customer_id: customer, amount: 5000, method: 'cash' as const, shift_id: shift, user_id: cashier }
    pos.payOutCustomerDeposit(payout)
    restart(); pos.payOutCustomerDeposit(payout)
    expect(pos.getCustomerDeposit(customer).balance).toBe(0)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(100000)
    expect(pos.soldItemsReport(period)).toEqual([])
    expect(db.prepare('SELECT COUNT(*) n FROM sales').get()).toEqual({ n: 0 })
  })
})
