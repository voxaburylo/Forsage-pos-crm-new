import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'

describe('local return document, money and stock consistency', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository
  let cashier: string, shift: string, product: string, sale: string, line: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-return-consistency-'))
    db = new LocalDatabase(root)
    pos = new LocalPosRepository(db)
    cashier = randomUUID()
    shift = pos.openShift({ cashier_id: cashier, opening_cash: 1000 })
    product = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: randomUUID(),
      name: 'Тест повернення', qty_on_hand: 10, retail_price: 100, purchase_price: 60 }).id
    sale = pos.checkout({ cashier_id: cashier, shift_id: shift,
      items: [{ product_id: product, qty: 3, unit_price: 100 }],
      payments: [{ method: 'cash', amount: 300 }],
    }).sale_id
    line = pos.getSaleForReturn(sale).items[0].id
  })
  afterEach(() => {
    db.close()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-return-consistency-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })
  const qty = () => (db.prepare('SELECT qty_on_hand AS qty FROM products WHERE id=?').get(product) as { qty: number }).qty
  const input = () => ({ sale_id: sale, approved_by: cashier, shift_id: shift, client_operation_id: randomUUID(),
    items: [{ sale_item_id: line, product_id: product, quantity: 1 }],
  })
  it.each([undefined, null])('uses defaults consistently for omitted/null options (%s)', (missing) => {
    const result = pos.createReturn({ ...input(), refund_method: missing, stock_action: missing })
    expect(result).toMatchObject({ refund_method: 'cash', stock_action: 'return_to_stock', refund_kopecks: 100 })
    expect(qty()).toBe(8)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(1200)
    const outbox = db.prepare("SELECT payload_json FROM sync_outbox WHERE operation_type='return.created'").get() as { payload_json: string }
    expect(JSON.parse(outbox.payload_json)).toMatchObject({ refund_method: 'cash', stock_action: 'return_to_stock' })
  })
  it('explicit terminal/write-off choices do not add stock or remove cash', () => {
    pos.createReturn({ ...input(), refund_method: 'terminal', stock_action: 'write_off' })
    expect(qty()).toBe(7)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(1300)
  })
  it('replays omitted and explicit defaults once, including after restart', () => {
    const request = input()
    const first = pos.createReturn(request)
    db.close(); db = new LocalDatabase(root); pos = new LocalPosRepository(db)
    expect(pos.createReturn({ ...request, refund_method: 'cash', stock_action: 'return_to_stock' }).id).toBe(first.id)
    expect(qty()).toBe(8)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(1200)
    expect(db.prepare('SELECT COUNT(*) AS n FROM customer_returns').get()).toEqual({ n: 1 })
  })
  it('rolls back stock, money, history and document if the journal write fails', () => {
    db.exec("CREATE TRIGGER fail_return BEFORE INSERT ON sync_outbox WHEN NEW.operation_type='return.created' BEGIN SELECT RAISE(ABORT,'test return failure'); END")
    expect(() => pos.createReturn(input())).toThrow('test return failure')
    expect(qty()).toBe(7)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(1300)
    expect(db.prepare('SELECT COUNT(*) AS n FROM customer_returns').get()).toEqual({ n: 0 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM inventory_movements WHERE source_type='customer_return'").get()).toEqual({ n: 0 })
  })
  it('still validates available cash when the method was omitted', () => {
    pos.createCashOperation({ shift_id: shift, type: 'out', amount: 1300 })
    expect(() => pos.createReturn(input())).toThrow(/недостатньо/i)
    expect(qty()).toBe(7)
    expect(db.prepare('SELECT COUNT(*) AS n FROM customer_returns').get()).toEqual({ n: 0 })
  })
  it('allocates a receipt-wide discount across goods and free-amount lines', () => {
    const mixed = pos.checkout({ cashier_id: cashier, shift_id: shift,
      items: [{ product_id: product, qty: 1, unit_price: 100 }, { description: 'Інша оплата', qty: 1, unit_price: 900 }],
      discount: 100, payments: [{ method: 'cash', amount: 900 }],
    })
    const view = pos.getSaleForReturn(mixed.sale_id)
    expect(view.items).toHaveLength(1)
    expect(view.items[0].refundable_kopecks).toBe(90)
    expect(view.sale.refundable_kopecks).toBe(90)
    pos.createReturn({ ...input(), sale_id: mixed.sale_id,
      items: [{ product_id: product, sale_item_id: view.items[0].id, quantity: 1 }] })
    expect(pos.getSale(mixed.sale_id).status).toBe('completed')
  })
  it('does not create warehouse stock for a returned service', () => {
    const service = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: randomUUID(),
      name: 'Послуга тест', is_service: true, qty_on_hand: 0, retail_price: 100 }).id
    const receipt = pos.checkout({ cashier_id: cashier, shift_id: shift,
      items: [{ product_id: service, qty: 1, unit_price: 100 }], payments: [{ method: 'cash', amount: 100 }],
    })
    const item = pos.getSaleForReturn(receipt.sale_id).items[0]
    pos.createReturn({ ...input(), sale_id: receipt.sale_id, refund_method: 'cash', stock_action: 'return_to_stock',
      items: [{ product_id: service, sale_item_id: item.id, quantity: 1 }] })
    expect(db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get(service)).toEqual({ qty_on_hand: 0 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM inventory_movements WHERE product_id=? AND source_type='customer_return'").get(service)).toEqual({ n: 0 })
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(1300)
  })
  it.each(['customer_returns', 'customer_return_items'])('ignores deleted %s in order item completion', (table) => {
    const orderId = randomUUID(), orderLine = randomUUID(), now = new Date().toISOString()
    db.prepare("INSERT INTO customer_orders(id,tenant_id,status,sale_id,created_at,updated_at) VALUES (?,?,'completed',?,?,?)")
      .run(orderId, DEFAULT_TENANT_ID, sale, now, now)
    db.prepare("INSERT INTO customer_order_items(id,tenant_id,order_id,product_id,name,qty,item_status,created_at,updated_at) VALUES (?,?,?,?,'Test',3,'handed',?,?)")
      .run(orderLine, DEFAULT_TENANT_ID, orderId, product, now, now)
    const request = input()
    const old = pos.createReturn({ ...request, refund_method: 'terminal', stock_action: 'write_off',
      items: [{ ...request.items[0], quantity: 2 }] })
    if (table === 'customer_returns') db.prepare('UPDATE customer_returns SET deleted_at=? WHERE id=?').run(now, old.id)
    else db.prepare('UPDATE customer_return_items SET deleted_at=? WHERE return_id=?').run(now, old.id)
    pos.createReturn({ ...input(), refund_method: 'terminal', stock_action: 'write_off' })
    expect(pos.getSaleForReturn(sale).items[0].available_qty).toBe(2)
    expect(db.prepare('SELECT item_status FROM customer_order_items WHERE id=?').get(orderLine)).toEqual({ item_status: 'handed' })
  })
})
