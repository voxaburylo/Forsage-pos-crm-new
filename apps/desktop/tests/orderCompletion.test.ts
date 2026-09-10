import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'

describe('LocalOrderRepository.completeOrder', () => {
  let root = ''
  let db: LocalDatabase
  let repository: LocalOrderRepository
  let cashierId = ''
  let shiftId = ''

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-order-completion-'))
    db = new LocalDatabase(root)
    repository = new LocalOrderRepository(db)
    cashierId = randomUUID()
    shiftId = randomUUID()
    const timestamp = new Date().toISOString()
    db.prepare(`
      INSERT INTO shifts (
        id, tenant_id, cashier_id, status, opening_cash,
        opened_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'open', 0, ?, ?, ?)
    `).run(shiftId, DEFAULT_TENANT_ID, cashierId, timestamp, timestamp, timestamp)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-order-completion-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function insertProduct(input: { qty: number; price: number; coreDeposit?: number }) {
    const id = randomUUID()
    const timestamp = new Date().toISOString()
    db.prepare(`
      INSERT INTO products (
        id, tenant_id, sku, name, purchase_price, retail_price, qty_on_hand,
        requires_core_return, core_deposit_amount, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 200, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      DEFAULT_TENANT_ID,
      `SKU-${id.slice(0, 8)}`,
      'Core part',
      input.price,
      input.qty,
      input.coreDeposit ? 1 : 0,
      input.coreDeposit ?? 0,
      timestamp,
      timestamp,
    )
    return id
  }

  it('restores business documents, stock and payment replay receipts together from backup', async () => {
    const productId = insertProduct({ qty: 8, price: 500 })
    const { orderId } = createPaidOrder({ productId, qty: 2, unitPrice: 500 })
    const issued = repository.completeOrder(orderId, { user_id: cashierId, shift_id: shiftId })
    const tables = ['products', 'customer_orders', 'customer_order_items', 'order_payments', 'sales', 'sale_items', 'cash_operations', 'inventory_movements', 'stock_reserves', 'sync_outbox']
    const snapshot = () => Object.fromEntries(tables.map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]))
    const before = snapshot()
    const backup = await db.backupNow()
    db.prepare('UPDATE products SET qty_on_hand = 999 WHERE id = ?').run(productId)
    db.close()
    LocalDatabase.stageBackupForRestart(root, path.basename(backup))
    db = LocalDatabase.open(root).database
    repository = new LocalOrderRepository(db)
    expect(snapshot()).toEqual(before)
    expect(repository.completeOrder(orderId, { user_id: cashierId, shift_id: shiftId }).data.sale_id).toBe(issued.data.sale_id)
    expect(db.prepare('SELECT qty_on_hand FROM products WHERE id = ?').get(productId)).toEqual({ qty_on_hand: 6 })
  })

  it('never marks an order payment or issue as fiscal without a fiscal receipt', () => {
    const productId = insertProduct({ qty: 3, price: 500 })
    const { orderId } = createPaidOrder({ productId, qty: 1, unitPrice: 500 })
    const payments = db.prepare('SELECT COUNT(*) n FROM order_payments').get()
    expect(() => repository.addPayment(orderId, { user_id: cashierId, shift_id: shiftId, amount: 100, method: 'cash', is_fiscal: true })).toThrow(/фіскаль/i)
    expect(db.prepare('SELECT COUNT(*) n FROM order_payments').get()).toEqual(payments)
    expect(() => repository.completeOrder(orderId, { user_id: cashierId, shift_id: shiftId, is_fiscal: true })).toThrow(/фіскаль/i)
    expect(db.prepare('SELECT COUNT(*) n FROM sales').get()).toEqual({ n: 0 })
  })

  function createPaidOrder(input: {
    productId: string
    qty: number
    unitPrice: number
    itemStatus?: string
  }) {
    const itemId = randomUUID()
    const order = repository.saveOrder({
      tenant_id: DEFAULT_TENANT_ID,
      manager_id: cashierId,
      items: [{
        id: itemId,
        name: 'Core part',
        sku: 'CORE-PART',
        product_id: input.productId,
        buy_price: 200,
        sell_price: input.unitPrice,
        qty: input.qty,
        item_status: input.itemStatus ?? 'arrived',
      }],
    })
    repository.addPayment(order.id, {
      tenant_id: DEFAULT_TENANT_ID,
      user_id: cashierId,
      shift_id: shiftId,
      amount: order.total_amount,
      method: 'cash',
    })
    return { orderId: order.id as string, itemId }
  }

  function duplicateOrder(stock: number) {
    const productId = insertProduct({ qty: stock, price: 500 })
    const order = repository.saveOrder({ manager_id: cashierId, items: [1, 2].map(() => ({
      product_id: productId, name: 'Core part', qty: 1, sell_price: 500, item_status: 'arrived',
    })) })
    repository.addPayment(order.id, { user_id: cashierId, shift_id: shiftId, amount: 1000, method: 'cash' })
    return { order, productId }
  }

  it('subtracts duplicate product lines cumulatively', () => {
    const { order, productId } = duplicateOrder(10)
    repository.completeOrder(order.id, { user_id: cashierId, shift_id: shiftId })
    expect(db.prepare('SELECT qty_on_hand qty FROM products WHERE id = ?').get(productId)).toEqual({ qty: 8 })
  })

  it('rejects the combined quantity above stock without issuing any line', () => {
    const { order, productId } = duplicateOrder(2)
    db.prepare('UPDATE products SET qty_on_hand = 1 WHERE id = ?').run(productId)
    expect(() => repository.completeOrder(order.id, { user_id: cashierId, shift_id: shiftId })).toThrow(/Недостатньо/)
    expect(db.prepare('SELECT qty_on_hand qty FROM products WHERE id = ?').get(productId)).toEqual({ qty: 1 })
  })

  it('does not issue into a closed or another cashiers shift', () => {
    const { order } = duplicateOrder(10)
    db.prepare(`UPDATE shifts SET status = 'closed' WHERE id = ?`).run(shiftId)
    expect(() => repository.completeOrder(order.id, { user_id: cashierId, shift_id: shiftId })).toThrow(/змін/)
    db.prepare(`UPDATE shifts SET status = 'open', cashier_id = ? WHERE id = ?`).run(randomUUID(), shiftId)
    expect(() => repository.completeOrder(order.id, { user_id: cashierId, shift_id: shiftId })).toThrow(/змін/)
  })

  it('reserves stock, updates reservation on edit, and rejects a second order taking it', () => {
    const { order, productId } = duplicateOrder(2)
    expect(() => repository.saveOrder({ items: [{ product_id: productId, name: 'Part', qty: 1, sell_price: 500 }] })).toThrow(/резерв/)
    const current = repository.getOrder(order.id)
    const updated = repository.saveOrder({ expected_updated_at: current.updated_at, items: [order.items[0]] }, order.id)
    expect(db.prepare('SELECT SUM(qty) qty FROM stock_reserves WHERE order_id = ? AND released_at IS NULL').get(order.id)).toEqual({ qty: 1 })
    expect(updated.items).toHaveLength(1)
    expect(() => repository.saveOrder({ expected_updated_at: 'old-version', items: [] }, order.id)).toThrow(/вже змінено/)
  })

  it('replays order creation without another order and rejects a changed payload', () => {
    const input = { operation_id: randomUUID(), items: [{ name: 'Manual part', qty: 1, sell_price: 100, source_type: 'supplier' }] }
    const first = repository.saveOrder(input)
    expect(repository.saveOrder(input).id).toBe(first.id)
    expect(() => repository.saveOrder({ ...input, comment: 'Changed' })).toThrow(/інші дані/)
  })

  it('advances the edit version even if the computer clock goes backwards', () => {
    const first = repository.saveOrder({ items: [] })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
    try {
      const second = repository.saveOrder({ expected_updated_at: first.updated_at, comment: 'Edit one' }, first.id)
      expect(Date.parse(second.updated_at)).toBeGreaterThan(Date.parse(first.updated_at))
      expect(() => repository.saveOrder({ expected_updated_at: first.updated_at, comment: 'Stale edit' }, first.id)).toThrow(/вже змінено/)
    } finally { clock.mockRestore() }
  })

  it('rejects payment of a canceled order and another cashiers shift', () => {
    const productId = insertProduct({ qty: 10, price: 500 })
    const order = repository.saveOrder({ manager_id: cashierId, items: [{ product_id: productId, name: 'Part', qty: 1, sell_price: 500 }] })
    db.prepare(`UPDATE customer_orders SET status = 'canceled' WHERE id = ?`).run(order.id)
    expect(() => repository.addPayment(order.id, { user_id: cashierId, shift_id: shiftId, amount: 100, method: 'cash' })).toThrow(/скасован/)
    db.prepare(`UPDATE customer_orders SET status = 'new' WHERE id = ?`).run(order.id)
    expect(() => repository.addPayment(order.id, { user_id: randomUUID(), shift_id: shiftId, amount: 100, method: 'cash' })).toThrow(/змін/)
  })

  it('charges the product core deposit, includes handed lines, and replays without duplicate movements', () => {
    const productId = insertProduct({ qty: 10, price: 500, coreDeposit: 100 })
    const { orderId, itemId } = createPaidOrder({
      productId,
      qty: 2,
      unitPrice: 500,
      itemStatus: 'arrived',
    })

    db.prepare('UPDATE customer_order_items SET item_status = ? WHERE id = ?').run('handed', itemId)

    const savedOrder = repository.getOrder(orderId, DEFAULT_TENANT_ID)
    expect(savedOrder.total_amount).toBe(1_200)
    expect(savedOrder.items[0]).toMatchObject({
      id: itemId,
      core_deposit_amount: 100,
      core_return_status: 'pending',
    })

    const first = repository.completeOrder(orderId, {
      tenant_id: DEFAULT_TENANT_ID,
      user_id: cashierId,
      shift_id: shiftId,
    })
    const second = repository.completeOrder(orderId, {
      tenant_id: DEFAULT_TENANT_ID,
      user_id: cashierId,
      shift_id: shiftId,
    })

    expect(second.data.sale_id).toBe(first.data.sale_id)
    expect(db.prepare('SELECT subtotal, total FROM sales WHERE id = ?').get(first.data.sale_id)).toEqual({
      subtotal: 1_200,
      total: 1_200,
    })
    expect(db.prepare(`
      SELECT total, core_deposit_amount, core_return_status
      FROM sale_items WHERE sale_id = ?
    `).get(first.data.sale_id)).toEqual({
      total: 1_200,
      core_deposit_amount: 100,
      core_return_status: 'pending',
    })
    expect(db.prepare('SELECT qty_on_hand FROM products WHERE id = ?').get(productId)).toEqual({ qty_on_hand: 8 })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM inventory_movements
      WHERE source_type = 'order' AND source_id = ?
    `).get(orderId)).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM cash_operations').get()).toEqual({ count: 1 })
    expect(() => repository.saveOrder({ tenant_id: DEFAULT_TENANT_ID, items: [] }, orderId)).toThrow('не можна редагувати')
    expect(() => repository.updateOrderStatus(orderId, 'ready')).toThrow('змінювати не можна')
  })

  it('marks a fully returned issued order item and restores stock', () => {
    const productId = insertProduct({ qty: 3, price: 500 })
    const { orderId } = createPaidOrder({
      productId,
      qty: 1,
      unitPrice: 500,
      itemStatus: 'arrived',
    })
    const completed = repository.completeOrder(orderId, {
      tenant_id: DEFAULT_TENANT_ID,
      user_id: cashierId,
      shift_id: shiftId,
    })
    const pos = new LocalPosRepository(db)
    const sale = pos.getSaleForReturn(completed.data.sale_id, DEFAULT_TENANT_ID)

    pos.createReturn({
      tenant_id: DEFAULT_TENANT_ID,
      sale_id: completed.data.sale_id,
      approved_by: cashierId,
      shift_id: shiftId,
      reason: 'other',
      reason_note: 'Exchange test',
      refund_method: 'terminal',
      stock_action: 'return_to_stock',
      items: [{
        sale_item_id: sale.items[0].id,
        product_id: productId,
        quantity: 1,
        condition: 'good',
      }],
    })

    expect(repository.getOrder(orderId, DEFAULT_TENANT_ID).items[0].item_status).toBe('returned')
    expect(db.prepare('SELECT qty_on_hand FROM products WHERE id = ?').get(productId)).toEqual({ qty_on_hand: 3 })
  })

  it('repairs a completed order without sale_id and keeps the repair idempotent', () => {
    const productId = insertProduct({ qty: 4, price: 250 })
    const { orderId } = createPaidOrder({
      productId,
      qty: 1,
      unitPrice: 250,
      itemStatus: 'arrived',
    })
    db.prepare(`
      UPDATE customer_orders SET status = 'completed', sale_id = NULL
      WHERE id = ? AND tenant_id = ?
    `).run(orderId, DEFAULT_TENANT_ID)

    const repaired = repository.completeOrder(orderId, {
      tenant_id: DEFAULT_TENANT_ID,
      user_id: cashierId,
      shift_id: shiftId,
    })
    const replay = repository.completeOrder(orderId, {
      tenant_id: DEFAULT_TENANT_ID,
      user_id: cashierId,
      shift_id: shiftId,
    })

    expect(replay.data.sale_id).toBe(repaired.data.sale_id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM sales').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT qty_on_hand FROM products WHERE id = ?').get(productId)).toEqual({ qty_on_hand: 3 })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM inventory_movements
      WHERE source_type = 'order' AND source_id = ?
    `).get(orderId)).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM cash_operations').get()).toEqual({ count: 1 })
  })
  it('blocks issuing an order whose prepayment is greater than its final total', () => {
    const productId = insertProduct({ qty: 3, price: 500 })
    const { orderId } = createPaidOrder({ productId, qty: 1, unitPrice: 500 })
    db.prepare("UPDATE customer_orders SET status = 'lead' WHERE id = ?").run(orderId)
    repository.addPayment(orderId, {
      tenant_id: DEFAULT_TENANT_ID,
      user_id: cashierId,
      shift_id: shiftId,
      amount: 100,
      method: 'cash',
    })

    expect(() => repository.completeOrder(orderId, {
      tenant_id: DEFAULT_TENANT_ID,
      user_id: cashierId,
      shift_id: shiftId,
    })).toThrow(/Передоплата перевищує суму замовлення/)
    expect(db.prepare('SELECT COUNT(*) AS count FROM sales').get()).toEqual({ count: 0 })
  })
})
