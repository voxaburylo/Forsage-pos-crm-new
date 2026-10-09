import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LOCAL_SCHEMA_VERSION } from '../src/db/schema'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
import { LocalSecondarySyncImporter } from '../src/repositories/secondarySyncImporter'

describe('shift report: original sales, shift returns and drawer money are separate', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository, shift: string, product: string, customer: string
  function connect() { db = new LocalDatabase(root); pos = new LocalPosRepository(db) }
  function restart() { db.close(); connect() }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-28T10:00:00Z'))
    root = mkdtempSync(path.join(tmpdir(), 'forsage-shift-returns-')); connect()
    shift = pos.openShift({ cashier_id: 'cashier', opening_cash: 10000 })
    product = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: 'SHIFT-PART', name: 'Контрольний товар', qty_on_hand: 30, retail_price: 1000, purchase_price: 600 }).id
    customer = pos.saveCustomer({ full_name: 'Клієнт перевірки', phone: '0678881122' }).data.id
  })
  afterEach(() => {
    db.close(); vi.useRealTimers()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-shift-returns-')) rmSync(root, { recursive: true, force: true })
  })
  function sale(qty = 2, method: 'cash' | 'card' | 'transfer' | 'debt' = 'cash') {
    return pos.checkout({ client_operation_id: randomUUID(), cashier_id: 'cashier', customer_id: customer, shift_id: shift,
      items: [{ product_id: product, qty, unit_price: 1000 }], payments: [{ method, amount: qty * 1000 }] }).sale_id
  }
  function request(saleId: string, qty = 1, method = 'cash') {
    const line = pos.getSaleForReturn(saleId).items[0]
    return { client_operation_id: randomUUID(), sale_id: saleId, approved_by: 'cashier', shift_id: shift,
      refund_method: method, stock_action: 'return_to_stock', items: [{ sale_item_id: line.id, product_id: product, quantity: qty }] }
  }
  function report(): any { return pos.getShiftReport('cashier') }
  function nextDay() {
    pos.closeShift('cashier', pos.getExpectedCash('cashier')!.expected_amount, null, shift)
    vi.setSystemTime(new Date('2026-09-29T10:00:00Z')); restart()
    shift = pos.openShift({ cashier_id: 'cashier', opening_cash: 10000 })
  }
  function legacy(id: string, removeOutbox = false) {
    db.prepare('UPDATE customer_returns SET shift_id=NULL WHERE id=?').run(id)
    if (removeOutbox) db.prepare("DELETE FROM sync_outbox WHERE aggregate_type='customer_return' AND aggregate_id=?").run(id)
  }
  it('keeps a receipt in gross sales after both partial and full returns, subtracting refunds once', () => {
    const id = sale()
    expect(report()).toMatchObject({ total_sales: 1, gross_revenue: 2000, refund_total: 0, total_revenue: 2000, payment_received_total: 2000 })
    pos.createReturn(request(id))
    expect(report()).toMatchObject({ total_sales: 1, gross_revenue: 2000, refund_total: 1000, total_revenue: 1000, payment_received_total: 2000, payment_refunded_total: 1000, payment_net_total: 1000, refunds_by_method: { cash: 1000 } })
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(11000)
    pos.createReturn(request(id))
    expect(report()).toMatchObject({ total_sales: 1, gross_revenue: 2000, refund_total: 2000, total_revenue: 0, payment_received_total: 2000, payment_net_total: 0 })
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(10000)
  })
  it('puts a later return into its own shift without rewriting the closed drawer totals', () => {
    const id = sale(1), oldShift = shift
    nextDay()
    const before = db.prepare('SELECT * FROM shifts WHERE id=?').get(oldShift)
    pos.createReturn(request(id))
    expect(report()).toMatchObject({ total_sales: 0, gross_revenue: 0, refund_total: 1000, total_revenue: -1000, payment_received_total: 0, payment_net_total: -1000 })
    expect(db.prepare('SELECT * FROM shifts WHERE id=?').get(oldShift)).toEqual(before)
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(9000)
  })
  it.each([['terminal', 'card', 'card'], ['credit', 'account', 'cash'], ['debt_reduction', 'debt', 'debt']] as const)(
    'separates %s return from the cash drawer', (refundMethod, bucket, payment) => {
      const id = sale(1, payment), beforeCash = pos.getExpectedCash('cashier')!.expected_amount
      pos.createReturn(request(id, 1, refundMethod))
      expect(report()).toMatchObject({ total_sales: 1, gross_revenue: 1000, refund_total: 1000, total_revenue: 0, refunds_by_method: { [bucket]: 1000 } })
      expect(report().payment_refunded_total).toBe(refundMethod === 'debt_reduction' ? 0 : 1000)
      expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(beforeCash)
    })
  it('keeps mixed cash/transfer receipts gross and terminal refunds separate', () => {
    const id = pos.checkout({ cashier_id: 'cashier', shift_id: shift,
      items: [{ product_id: product, qty: 1, unit_price: 1000 }], payments: [{ method: 'cash', amount: 700 }, { method: 'transfer', amount: 300 }] }).sale_id
    pos.createReturn(request(id, 1, 'terminal'))
    expect(report()).toMatchObject({ by_method: { cash: 700, transfer: 300, card: 0 }, refunds_by_method: { cash: 0, card: 1000 }, payment_net_total: 0 })
    expect(pos.getExpectedCash('cashier')?.expected_amount).toBe(10700)
  })
  it('does not count an archived completed order payment twice', () => {
    const orders = new LocalOrderRepository(db)
    const order = orders.saveOrder({ manager_id: 'cashier', customer_id: customer,
      items: [{ product_id: product, name: 'Контрольний товар', qty: 1, buy_price: 600, sell_price: 1000, item_status: 'arrived' }] })
    orders.addPayment(order.id, { payment_id: randomUUID(), user_id: 'cashier', shift_id: shift, amount: 1000, method: 'card' })
    orders.completeOrder(order.id, { user_id: 'cashier', shift_id: shift })
    db.prepare('UPDATE customer_orders SET deleted_at=? WHERE id=?').run(new Date().toISOString(), order.id)
    expect(report()).toMatchObject({ gross_revenue: 1000, payment_received_total: 1000, by_method: { card: 1000 } })
  })
  it('uses real payment rows before legacy summary columns', () => {
    const id = sale(1, 'transfer')
    db.prepare("UPDATE sales SET cash_amount=1000,transfer_amount=0,payment_method='cash' WHERE id=?").run(id)
    expect(report()).toMatchObject({ payment_received_total: 1000, by_method: { cash: 0, transfer: 1000 } })
  })
  it('records the exact shift for a terminal return and keeps it after outbox cleanup', () => {
    const id = pos.createReturn(request(sale(1, 'card'), 1, 'terminal')).id
    expect(db.prepare('SELECT shift_id FROM customer_returns WHERE id=?').get(id)).toEqual({ shift_id: shift })
    db.prepare("DELETE FROM sync_outbox WHERE aggregate_type='customer_return'").run()
    restart()
    expect(report()).toMatchObject({ refund_total: 1000, unassigned_refunds_count: 0 })
  })
  it.each(['terminal', 'credit', 'debt_reduction'])('rejects a supplied foreign shift for %s before any write', method => {
    const foreign = pos.openShift({ cashier_id: 'another', opening_cash: 10000 })
    const id = sale(1, method === 'debt_reduction' ? 'debt' : 'cash')
    const before = db.prepare('SELECT total_changes() n').get()
    expect(() => pos.createReturn({ ...request(id, 1, method), shift_id: foreign })).toThrow(/зміна|змін/i)
    expect(db.prepare('SELECT total_changes() n').get()).toEqual(before)
  })
  it('resolves an old cash return from its exact cash operation, not the original sale shift', () => {
    const saleId = sale(1); nextDay()
    const id = pos.createReturn(request(saleId)).id; legacy(id, true)
    expect(report()).toMatchObject({ refund_total: 1000, refunds_by_method: { cash: 1000 }, unassigned_refunds_count: 0 })
  })
  it('resolves an old terminal return from its saved outbox event', () => {
    const id = pos.createReturn(request(sale(1), 1, 'terminal')).id; legacy(id)
    // A saved event is stronger than a changed legacy timestamp.
    db.prepare('UPDATE customer_returns SET created_at=? WHERE id=?').run('2026-09-27T10:00:00Z', id)
    expect(report()).toMatchObject({ refund_total: 1000, unassigned_refunds_count: 0 })
  })
  it('uses only one unambiguous historical cashier/time interval after queue cleanup', () => {
    const id = pos.createReturn(request(sale(1), 1, 'terminal')).id; legacy(id, true)
    expect(report()).toMatchObject({ refund_total: 1000, unassigned_refunds_count: 0 })
  })
  it('marks overlapping legacy shifts as incomplete instead of guessing', () => {
    const id = pos.createReturn(request(sale(1), 1, 'terminal')).id; legacy(id, true)
    db.prepare("INSERT INTO shifts(id,tenant_id,cashier_id,status,opening_cash,opened_at,closed_at,created_at,updated_at) VALUES ('overlap',?,'cashier','closed',0,?,?,?,?)")
      .run(tenant, '2026-09-28T09:00:00Z', '2026-09-28T11:00:00Z', new Date().toISOString(), new Date().toISOString())
    expect(report()).toMatchObject({ refund_total: 0, unassigned_refunds_count: 1 })
  })
  it('handles malformed old outbox JSON without losing an otherwise unambiguous return', () => {
    const id = pos.createReturn(request(sale(1), 1, 'terminal')).id; legacy(id)
    db.prepare("UPDATE sync_outbox SET payload_json='{broken' WHERE aggregate_id=? AND operation_type='return.created'").run(id)
    expect(report()).toMatchObject({ refund_total: 1000, unassigned_refunds_count: 0 })
  })
  it('does not silently choose between conflicting historical shift links', () => {
    const id = pos.createReturn(request(sale(1))).id; legacy(id)
    const foreign = pos.openShift({ cashier_id: 'another', opening_cash: 10000 })
    db.prepare("UPDATE sync_outbox SET payload_json=json_set(payload_json,'$.shift_id',?) WHERE aggregate_id=? AND operation_type='return.created'").run(foreign, id)
    expect(report()).toMatchObject({ refund_total: 0, unassigned_refunds_count: 1 })
  })
  it.each(['record', 'event'])('warns about a %s link to a nonexistent shift instead of hiding the refund', source => {
    const id = pos.createReturn(request(sale(1), 1, 'terminal')).id
    legacy(id, source === 'record')
    if (source === 'record') db.prepare('UPDATE customer_returns SET shift_id=? WHERE id=?').run('missing-shift', id)
    else db.prepare("UPDATE sync_outbox SET payload_json=json_set(payload_json,'$.shift_id',?) WHERE aggregate_id=?").run('missing-shift', id)
    expect(report()).toMatchObject({ refund_total: 0, unassigned_refunds_count: 1 })
  })
  it('ignores canceled/deleted returns and deleted manual cash operations', () => {
    const id = pos.createReturn(request(sale(2))).id
    db.prepare("UPDATE customer_returns SET status='cancelled' WHERE id=?").run(id)
    expect(report().refund_total).toBe(0)
    db.prepare("UPDATE customer_returns SET status='completed',deleted_at=? WHERE id=?").run(new Date().toISOString(), id)
    expect(report().refund_total).toBe(0)
    const op = pos.createCashOperation({ shift_id: shift, type: 'in', amount: 1234 })
    db.prepare('UPDATE cash_operations SET deleted_at=? WHERE id=?').run(new Date().toISOString(), op.id)
    expect(pos.getCashOperationSummary(shift)).toEqual({ total_in: 0, total_out: 0, net: 0 })
  })

  it('keeps legacy payment columns as a single fallback, without replacing mixed zero columns', () => {
    const id = sale(1, 'transfer')
    db.prepare('DELETE FROM sale_payments WHERE sale_id=?').run(id)
    expect(report().by_method).toMatchObject({ cash: 0, transfer: 1000 })
    db.prepare("UPDATE sales SET cash_amount=600,transfer_amount=400,payment_method='cash' WHERE id=?").run(id)
    expect(report()).toMatchObject({ payment_received_total: 1000, by_method: { cash: 600, transfer: 400 } })
  })
  it('does not count another cashier or tenant return in this shift', () => {
    const id = pos.createReturn(request(sale(1), 1, 'terminal')).id
    const other = pos.openShift({ cashier_id: 'another', opening_cash: 0 })
    db.prepare("UPDATE customer_returns SET shift_id=?,approved_by='another' WHERE id=?").run(other, id)
    db.prepare('DELETE FROM sync_outbox WHERE aggregate_id=?').run(id)
    expect(report()).toMatchObject({ refund_total: 0, unassigned_refunds_count: 0 })
    db.prepare('UPDATE customer_returns SET tenant_id=?,shift_id=? WHERE id=?').run('foreign-tenant', shift, id)
    expect(report()).toMatchObject({ refund_total: 0, unassigned_refunds_count: 0 })
  })
  it.each(['unknown-legacy', 'constructor', '__proto__'])('warns about historical refund method %s instead of calling it zero', method => {
    const id = pos.createReturn(request(sale(1), 1, 'terminal')).id
    db.prepare('UPDATE customer_returns SET refund_method=? WHERE id=?').run(method, id)
    expect(report()).toMatchObject({ refund_total: 0, unassigned_refunds_count: 1 })
  })
  it('allows an existing noncash flow without an open shift, without attributing it to the old sale shift', () => {
    const id = sale(1, 'card'), input = { ...request(id, 1, 'terminal'), shift_id: undefined }
    pos.closeShift('cashier', pos.getExpectedCash('cashier')!.expected_amount, null, shift)
    vi.setSystemTime(new Date('2026-09-28T12:00:00Z'))
    const returned = pos.createReturn(input)
    expect(db.prepare('SELECT shift_id FROM customer_returns WHERE id=?').get(returned.id)).toEqual({ shift_id: null })
    expect(report()).toBeNull()
    vi.setSystemTime(new Date('2026-09-28T13:00:00Z'))
    shift = pos.openShift({ cashier_id: 'cashier', opening_cash: 10000 })
    expect(report()).toMatchObject({ total_sales: 0, refund_total: 0, unassigned_refunds_count: 0 })
  })
  it('rejects a closed shift for noncash returns before writing anything', () => {
    const input = request(sale(1), 1, 'terminal')
    pos.closeShift('cashier', pos.getExpectedCash('cashier')!.expected_amount, null, shift)
    const before = db.prepare('SELECT total_changes() n').get()
    expect(() => pos.createReturn(input)).toThrow(/зміна/)
    expect(db.prepare('SELECT total_changes() n').get()).toEqual(before)
  })
  it('migrates a v26 copy without altering stock, payments, return history or the outgoing queue', () => {
    const id = pos.createReturn(request(sale(2), 1, 'terminal')).id
    // Only this generated fixture is reverted to the previous schema.
    db.exec('DROP INDEX idx_customer_returns_shift; ALTER TABLE customer_returns DROP COLUMN shift_id; ALTER TABLE supplier_price_imports DROP COLUMN scope_known; DELETE FROM schema_migrations WHERE version>=27')
    const tables = ['products', 'sales', 'sale_items', 'sale_payments', 'customer_return_items', 'cash_operations', 'sync_outbox', 'shifts']
    const before = tables.map(table => db.prepare('SELECT * FROM ' + table).all())
    const oldReturn = db.prepare('SELECT * FROM customer_returns WHERE id=?').get(id)
    restart()
    expect(db.info().schemaVersion).toBe(LOCAL_SCHEMA_VERSION)
    expect(tables.map(table => db.prepare('SELECT * FROM ' + table).all())).toEqual(before)
    expect(db.prepare('SELECT * FROM customer_returns WHERE id=?').get(id)).toEqual({ ...oldReturn, shift_id: null })
    expect(report()).toMatchObject({ gross_revenue: 2000, refund_total: 1000, total_revenue: 1000 })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    restart()
    expect(report().refund_total).toBe(1000)
  })
  it('keeps exact return shift metadata when importing new or older snapshots', () => {
    const sourceId = pos.createReturn(request(sale(1), 1, 'terminal')).id
    const source = db.prepare('SELECT * FROM customer_returns WHERE id=?').get(sourceId) as any
    const targetId = randomUUID(), importer = new LocalSecondarySyncImporter(db)
    const returned = { ...source, id: targetId, dirty_at: null, client_operation_id: null, client_payload_hash: null }
    importer.apply(tenant, { customer_returns: [returned] }, new Date().toISOString())
    expect(db.prepare('SELECT shift_id FROM customer_returns WHERE id=?').get(targetId)).toEqual({ shift_id: shift })
    delete returned.shift_id
    importer.apply(tenant, { customer_returns: [returned] }, new Date().toISOString())
    expect(db.prepare('SELECT shift_id FROM customer_returns WHERE id=?').get(targetId)).toEqual({ shift_id: shift })
  })


  it('restores a refund with its exact shift from a verified backup after queue cleanup', async () => {
    const id = pos.createReturn(request(sale(1, 'card'), 1, 'terminal')).id
    db.prepare('DELETE FROM sync_outbox WHERE aggregate_id=?').run(id)
    const expected = report(), backup = await db.backupNow()
    const restoredRoot = path.join(root, 'restored')
    mkdirSync(path.join(restoredRoot, 'data'), { recursive: true })
    copyFileSync(backup, path.join(restoredRoot, 'data', 'forsage.db'))
    const restored = new LocalDatabase(restoredRoot)
    try {
      expect(new LocalPosRepository(restored).getShiftReport('cashier')).toEqual(expected)
      expect(restored.prepare('SELECT shift_id FROM customer_returns WHERE id=?').get(id)).toEqual({ shift_id: shift })
      expect(restored.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { restored.close() }
  })

  it('keeps the return and report stable across a lost response and restart; reading writes nothing', () => {
    const input = request(sale(1)), first = pos.createReturn(input)
    const expected = report(); restart(); expect(pos.createReturn(input).id).toBe(first.id)
    const before = db.prepare('SELECT total_changes() n').get()
    expect(report()).toEqual(expected); expect(report()).toEqual(expected)
    expect(db.prepare('SELECT total_changes() n').get()).toEqual(before)
  })
})
