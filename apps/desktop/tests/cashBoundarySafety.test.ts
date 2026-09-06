import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'

describe('cash boundaries', () => {
  let root: string
  let db: LocalDatabase
  let pos: LocalPosRepository
  let cashier: string
  let shift: string
  let customer: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-cash-boundary-'))
    db = new LocalDatabase(root)
    pos = new LocalPosRepository(db)
    cashier = randomUUID()
    shift = pos.openShift({ cashier_id: cashier, opening_cash: 100 })
    customer = pos.saveCustomer({ phone: '+380501234567', full_name: 'Перевірка коштів' }).data.id
    pos.addCustomerDeposit({ customer_id: customer, amount: 500, method: 'card' })
  })
  afterEach(() => {
    db.close()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-cash-boundary-')) rmSync(root, { recursive: true, force: true })
  })
  it('does not pay out a customer balance from insufficient cash', () => {
    expect(() => pos.payOutCustomerDeposit({ customer_id: customer, amount: 200, method: 'cash', shift_id: shift })).toThrow(/недостатньо/i)
    expect(pos.getCustomerDeposit(customer).balance).toBe(500)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(100)
  })
  it('does not receive a deposit into an already closed shift', () => {
    pos.closeShift(cashier, 100, null)
    expect(() => pos.addCustomerDeposit({ customer_id: customer, amount: 50, method: 'cash', shift_id: shift })).toThrow(/змін/i)
    expect(pos.getCustomerDeposit(customer).balance).toBe(500)
  })
  it('rolls back manual cash movement if its outbox insert fails', () => {
    db.exec(`CREATE TRIGGER fail_cash BEFORE INSERT ON sync_outbox WHEN NEW.operation_type = 'cash_operation.created' BEGIN SELECT RAISE(ABORT, 'test failure'); END`)
    expect(() => pos.createCashOperation({ shift_id: shift, type: 'in', amount: 50 })).toThrow('test failure')
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(100)
  })
  it('does not allow a manual cash withdrawal above available money', () => {
    expect(() => pos.createCashOperation({ shift_id: shift, type: 'out', amount: 101 })).toThrow(/недостатньо/i)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(100)
  })
  it('does not disguise an old negative cash balance as zero', () => {
    pos.createCashOperation({ shift_id: shift, type: 'out', amount: 100 })
    db.prepare("UPDATE cash_operations SET amount = 150 WHERE shift_id = ? AND type = 'cash_out'").run(shift)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(-50)
  })
  it('replays a supplier payment once and rejects reuse with other payment details', () => {
    const product = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: randomUUID(), name: 'Перевірка', qty_on_hand: 0 })
    const supply = new LocalSupplyRepository(db)
    const invoice = supply.createInvoice({ items: [{ product_id: product.id, qty: 1, purchase_price: 500 }] })
    supply.postInvoice(invoice.id)
    const payment = { payment_id: randomUUID(), amount: 500, payment_method: 'cash' as const, fund_source: 'owner_funds' as const }
    supply.payInvoice(invoice.id, payment)
    expect(supply.payInvoice(invoice.id, payment).paid_amount).toBe(500)
    expect(() => supply.payInvoice(invoice.id, { ...payment, payment_method: 'card' })).toThrow(/ідентифікатор/i)
    expect(db.prepare('SELECT COUNT(*) AS n FROM supplier_payments WHERE invoice_id = ?').get(invoice.id)).toEqual({ n: 1 })
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(100)
  })
})
