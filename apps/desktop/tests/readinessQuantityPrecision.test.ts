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

describe('readiness: exact thousandths across stock documents', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository, supply: LocalSupplyRepository
  let warehouse: LocalWarehouseRepository, inventory: LocalInventoryRepository
  let cashier: string, shift: string, product: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-readiness-quantity-'))
    db = new LocalDatabase(root)
    pos = new LocalPosRepository(db); supply = new LocalSupplyRepository(db)
    warehouse = new LocalWarehouseRepository(db); inventory = new LocalInventoryRepository(db)
    cashier = randomUUID(); shift = pos.openShift({ cashier_id: cashier, opening_cash: 10000 })
    product = new LocalCatalogRepository(db).upsertProduct({
      id: randomUUID(), sku: randomUUID(), name: 'Олива на розлив', unit: 'л',
      qty_on_hand: 0, purchase_price: 1000, retail_price: 2000,
    }).id
  })
  afterEach(() => {
    db.close()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-readiness-quantity-')) rmSync(root, { recursive: true, force: true })
  })
  const stock = () => (db.prepare('SELECT qty_on_hand qty FROM products WHERE id=?').get(product) as { qty: number }).qty
  const receive = (qty: number) => {
    const invoice = supply.createInvoice({ items: [{ product_id: product, qty, purchase_price: 1000 }] })
    return supply.postInvoice(invoice.id)
  }
  const sell = (...quantities: number[]) => pos.checkout({
    cashier_id: cashier, shift_id: shift, client_operation_id: randomUUID(),
    items: quantities.map(qty => ({ product_id: product, qty, unit_price: 2000 })),
    payments: [{ method: 'cash', amount: quantities.reduce((sum, qty) => sum + Math.round(qty * 2000), 0) }],
  })
  const ledger = () => db.prepare('SELECT qty_delta, qty_after FROM inventory_movements WHERE product_id=? ORDER BY rowid')
    .all(product) as Array<{ qty_delta: number; qty_after: number }>

  it('sells the complete 0.3 in two parts and keeps an exact ledger across restart', () => {
    receive(0.3); sell(0.1)
    expect(stock()).toBe(0.2)
    db.close(); db = new LocalDatabase(root); pos = new LocalPosRepository(db)
    sell(0.2)
    expect(stock()).toBe(0)
    expect(ledger()).toEqual([{ qty_delta: 0.3, qty_after: 0.3 }, { qty_delta: -0.1, qty_after: 0.2 }, { qty_delta: -0.2, qty_after: 0 }])
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(10600)
  })
  it('combines two lines of one product without a false insufficient-stock error', () => {
    receive(0.3); sell(0.1, 0.2)
    expect(stock()).toBe(0)
  })
  it('receives and cancels fractional invoices without inventing residual stock', () => {
    const first = receive(0.1), second = receive(0.2)
    expect(stock()).toBe(0.3)
    supply.cancelInvoice(first.id)
    expect(stock()).toBe(0.2)
    supply.cancelInvoice(second.id)
    expect(stock()).toBe(0)
    expect(ledger()).toEqual([
      { qty_delta: 0.1, qty_after: 0.1 }, { qty_delta: 0.2, qty_after: 0.3 },
      { qty_delta: -0.1, qty_after: 0.2 }, { qty_delta: -0.2, qty_after: 0 },
    ])
  })
  it('allows selling all unreserved fractional stock and keeps the reserved part', () => {
    receive(0.3)
    warehouse.createReserve({ product_id: product, qty: 0.1 })
    sell(0.2)
    expect(stock()).toBe(0.1)
    expect(() => sell(0.001)).toThrow(/Недостатньо/)
  })
  it('allows separate reservations up to the exact stock, but not above it', () => {
    receive(0.3)
    warehouse.createReserve({ product_id: product, qty: 0.1 })
    warehouse.createReserve({ product_id: product, qty: 0.2 })
    expect(warehouse.listReserves()).toHaveLength(2)
    expect(() => warehouse.createReserve({ product_id: product, qty: 0.001 })).toThrow(/Недостатньо/)
  })
  it('writes off the remaining fraction after a sale', () => {
    receive(0.3); sell(0.1)
    warehouse.createWriteoff({ reason: 'damage', items: [{ product_id: product, qty: 0.2 }] })
    expect(stock()).toBe(0)
    expect(ledger().at(-1)).toMatchObject({ qty_delta: -0.2, qty_after: 0 })
  })
  it('counts 0.1 plus 0.2 and then sells exactly 0.3', () => {
    const session = inventory.createSession({ name: 'Дробовий перерахунок' }).id
    inventory.startSession(session)
    inventory.countProduct(session, { product_id: product, qty: 0.1 })
    inventory.countProduct(session, { product_id: product, qty: 0.2 })
    expect(inventory.getSessionData(session).items[0].counted_stock).toBe(0.3)
    inventory.complete(session)
    expect(stock()).toBe(0.3)
    sell(0.3)
    expect(stock()).toBe(0)
  })
  it('issues an order with repeated fractional product lines once, without duplicate cash', () => {
    receive(0.3)
    const orders = new LocalOrderRepository(db)
    const order = orders.saveOrder({ manager_id: cashier, items: [0.1, 0.2].map(qty => ({
      product_id: product, name: 'Олива на розлив', qty, buy_price: 1000, sell_price: 2000, item_status: 'arrived',
    })) })
    const payment = { payment_id: randomUUID(), user_id: cashier, shift_id: shift, method: 'cash' as const, amount: 600 }
    orders.addPayment(order.id, payment)
    const issued = orders.completeOrder(order.id, { user_id: cashier, shift_id: shift })
    expect(stock()).toBe(0)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(10600)
    db.close(); db = new LocalDatabase(root); pos = new LocalPosRepository(db)
    expect(new LocalOrderRepository(db).completeOrder(order.id, { user_id: cashier, shift_id: shift }).data.sale_id).toBe(issued.data.sale_id)
    expect(stock()).toBe(0)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(10600)
  })
  it('keeps the active order line reserved when a duplicate product line is cancelled', () => {
    receive(0.3)
    const orders = new LocalOrderRepository(db)
    const order = orders.saveOrder({ manager_id: cashier, items: [0.1, 0.2].map(qty => ({
      product_id: product, name: 'Олива на розлив', qty, buy_price: 1000, sell_price: 2000, item_status: 'pending',
    })) })
    orders.updateOrderItemStatus(order.id, order.items[0].id, 'canceled')
    expect(warehouse.listReserves()).toEqual([expect.objectContaining({ product_id: product, qty: 0.2, order_id: order.id })])
    expect(() => sell(0.2)).toThrow(/Недостатньо/)
    sell(0.1)
    expect(stock()).toBe(0.2)
  })
  it('handles old floating tails but never silently rounds real fourth decimals in stored stock', () => {
    receive(1)
    db.prepare('UPDATE products SET qty_on_hand=? WHERE id=?').run(0.19999999999999998, product)
    sell(0.2)
    expect(stock()).toBe(0)
    db.prepare('UPDATE products SET qty_on_hand=? WHERE id=?').run(0.2004, product)
    expect(() => sell(0.2)).toThrow(/3 знаків/)
    expect(stock()).toBe(0.2004)
  })
  it('rejects one thousandth more than available without changing any document', () => {
    receive(0.3)
    const before = ledger()
    expect(() => sell(0.301)).toThrow(/Недостатньо/)
    expect(() => warehouse.createReserve({ product_id: product, qty: 0.301 })).toThrow(/Недостатньо/)
    expect(() => warehouse.createWriteoff({ reason: 'damage', items: [{ product_id: product, qty: 0.301 }] })).toThrow(/Недостатньо/)
    expect(stock()).toBe(0.3)
    expect(ledger()).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) n FROM sales').get()).toEqual({ n: 0 })
  })
  it('rolls back the fractional stock and all sale rows when the journal write fails', () => {
    receive(0.3)
    const tables = ['products', 'sales', 'sale_items', 'sale_payments', 'inventory_movements', 'cash_operations', 'sync_outbox']
    const snapshot = () => tables.map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all())
    const before = snapshot()
    db.exec("CREATE TRIGGER fail_fraction BEFORE INSERT ON sync_outbox WHEN NEW.operation_type='sale.completed' BEGIN SELECT RAISE(ABORT, 'fraction test failure'); END")
    expect(() => sell(0.1, 0.2)).toThrow('fraction test failure')
    expect(snapshot()).toEqual(before)
    db.exec('DROP TRIGGER fail_fraction')
    sell(0.1, 0.2)
    expect(stock()).toBe(0)
  })
  it('matches an independent integer ledger for 25 receive/sale/return/write-off/recount cycles', () => {
    // The oracle uses integer millilitres and whole kopecks, never production helpers.
    let expectedUnits = 0, expectedCash = 10000
    let seed = 7829
    const random = (limit: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % limit }
    const check = () => {
      expect(stock()).toBe(expectedUnits / 1000)
      expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(expectedCash)
      let accumulated = 0
      for (const movement of ledger()) {
        accumulated += Math.round(movement.qty_delta * 1000)
        expect(movement.qty_after).toBe(accumulated / 1000)
      }
      expect(accumulated).toBe(expectedUnits)
    }
    for (let cycle = 0; cycle < 25; cycle++) {
      const received = 300 + random(701)
      receive(received / 1000); expectedUnits += received; check()
      const sold = 100 + random(100)
      const receipt = sell(sold / 1000); expectedUnits -= sold; expectedCash += sold * 2; check()
      const returned = 1 + random(sold)
      const line = pos.getSaleForReturn(receipt.sale_id).items[0]
      const returnRequest = {
        sale_id: receipt.sale_id, approved_by: cashier, shift_id: shift, client_operation_id: randomUUID(),
        items: [{ sale_item_id: line.id, product_id: product, quantity: returned / 1000 }],
      }
      pos.createReturn(returnRequest); expectedUnits += returned; expectedCash -= returned * 2; check()
      pos.createReturn(returnRequest); check()
      const writtenOff = 1 + random(50)
      const writeoff = { reason: 'loss', user_id: cashier, operation_id: randomUUID(), items: [{ product_id: product, qty: writtenOff / 1000 }] }
      warehouse.createWriteoff(writeoff); expectedUnits -= writtenOff; check()
      warehouse.createWriteoff(writeoff); check()
      const session = inventory.createSession({ name: 'Контроль ' + cycle }).id
      inventory.startSession(session)
      expectedUnits += random(11) - 5
      inventory.countProduct(session, { product_id: product, qty: expectedUnits / 1000 })
      inventory.complete(session); check()
      inventory.complete(session); check()
      if (cycle % 5 === 4) {
        db.close(); db = new LocalDatabase(root)
        pos = new LocalPosRepository(db); supply = new LocalSupplyRepository(db)
        warehouse = new LocalWarehouseRepository(db); inventory = new LocalInventoryRepository(db)
        check()
      }
    }
    const count = ledger().length
    pos.closeShift(cashier, expectedCash, null, shift)
    expect(pos.getOpenShift(cashier)).toBeNull()
    expect(ledger()).toHaveLength(count)
  })
  it('never commits a quantity that the existing return workflow cannot return', () => {
    receive(1)
    expect(() => sell(0.0005)).toThrow()
    expect(stock()).toBe(1)
    expect(db.prepare('SELECT COUNT(*) n FROM sales').get()).toEqual({ n: 0 })
  })
  it('rejects excessive precision in a receipt before creating the document', () => {
    expect(() => receive(0.0001)).toThrow()
    expect(db.prepare('SELECT COUNT(*) n FROM supply_invoices').get()).toEqual({ n: 0 })
    expect(stock()).toBe(0)
  })
})
