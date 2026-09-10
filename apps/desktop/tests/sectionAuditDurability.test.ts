import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalWarehouseRepository } from '../src/repositories/warehouseRepository'
import { LocalStaffRepository } from '../src/repositories/staffRepository'

describe('section audit: durable financial and stock writes', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository, customer: string, cashier: string, shift: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-section-audit-'))
    db = new LocalDatabase(root); pos = new LocalPosRepository(db)
    customer = pos.saveCustomer({ phone: '0500000011', full_name: 'Test' }).data.id
    cashier = randomUUID(); shift = pos.openShift({ cashier_id: cashier, opening_cash: 1000 })
  })
  afterEach(() => { db.close(); if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-section-audit-')) rmSync(root, { recursive: true, force: true }) })
  it('does not top up twice after a lost reply and restart', () => {
    const request = { operation_id: randomUUID(), customer_id: customer, amount: 200, method: 'cash' as const, shift_id: shift, user_id: cashier }
    const first = pos.addCustomerDeposit(request)
    db.close(); db = new LocalDatabase(root); pos = new LocalPosRepository(db)
    expect(pos.addCustomerDeposit(request)).toEqual(first)
    expect(pos.getCustomerDeposit(customer).balance).toBe(200)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(1200)
    expect(() => pos.addCustomerDeposit({ ...request, amount: 300 })).toThrow('інші дані')
  })
  it('does not pay debt twice, including after the shift closes', () => {
    db.prepare('UPDATE customers SET debt_balance = 500 WHERE id = ?').run(customer)
    const request = { operation_id: randomUUID(), customer_id: customer, amount: 200, method: 'cash' as const, shift_id: shift, user_id: cashier }
    const first = pos.payDebt(request)
    pos.closeShift(cashier, 1200, null)
    expect(pos.payDebt(request)).toEqual(first)
    expect(pos.getCustomer(customer).debt_balance).toBe(300)
  })
  it('does not retain a replay receipt or partial balance after an outbox error', () => {
    const request = { operation_id: randomUUID(), customer_id: customer, amount: 200, method: 'card' as const }
    db.exec("CREATE TRIGGER fail_deposit BEFORE INSERT ON sync_outbox WHEN NEW.operation_type = 'customer.deposit_changed' BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    expect(() => pos.addCustomerDeposit(request)).toThrow('test failure')
    expect(pos.getCustomerDeposit(customer).balance).toBe(0)
    db.exec('DROP TRIGGER fail_deposit')
    expect(pos.addCustomerDeposit(request).data.balance).toBe(200)
  })
  it('rejects reusing a payout id with another method', () => {
    pos.addCustomerDeposit({ customer_id: customer, amount: 300, method: 'card' })
    const request = { payout_id: randomUUID(), customer_id: customer, amount: 100, method: 'card' as const }
    pos.payOutCustomerDeposit(request)
    expect(() => pos.payOutCustomerDeposit({ ...request, method: 'transfer' })).toThrow(/ідентифікатор/i)
    expect(pos.getCustomerDeposit(customer).balance).toBe(200)
  })
  it('a repeated writeoff preserves stock and movement count', () => {
    const product = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: randomUUID(), name: 'Audit product', qty_on_hand: 8, purchase_price: 100 })
    const warehouse = new LocalWarehouseRepository(db)
    const request = { operation_id: randomUUID(), reason: 'damage', items: [{ product_id: product.id, qty: 2 }] }
    const first = warehouse.createWriteoff(request)
    expect(warehouse.createWriteoff(request).id).toBe(first.id)
    expect(db.prepare('SELECT qty_on_hand n FROM products WHERE id = ?').get(product.id)).toEqual({ n: 6 })
    expect(db.prepare("SELECT count(*) n FROM inventory_movements WHERE source_type = 'writeoff'").get()).toEqual({ n: 1 })
  })
  it('a salary correction is inserted only once', () => {
    const id = randomUUID(), timestamp = new Date().toISOString()
    db.prepare("INSERT INTO staff_users (id, tenant_id, full_name, role, is_active, created_at, updated_at) VALUES (?, ?, 'Worker', 'manager', 1, ?, ?)").run(id, DEFAULT_TENANT_ID, timestamp, timestamp)
    const staff = new LocalStaffRepository(db)
    const request = { operation_id: randomUUID(), employee_id: id, amount: 300, type: 'bonus' as const, method: 'card' as const }
    const first = staff.createSalary(request)
    expect(staff.createSalary(request)).toEqual(first)
    expect(db.prepare('SELECT count(*) n FROM salary_payments WHERE employee_id = ?').get(id)).toEqual({ n: 1 })
    expect(() => staff.createSalary({ ...request, amount: 400 })).toThrow('інші дані')
  })
  it('rejects cash operations against another cashier shift', () => {
    const request = { customer_id: customer, amount: 100, method: 'cash' as const, shift_id: shift, user_id: randomUUID() }
    db.prepare('UPDATE customers SET debt_balance = 500, deposit_balance = 500 WHERE id = ?').run(customer)
    expect(() => pos.payDebt(request)).toThrow('власній')
    expect(() => pos.addCustomerDeposit(request)).toThrow('власній')
    expect(() => pos.payOutCustomerDeposit(request)).toThrow('власній')
    expect(pos.getCustomerDeposit(customer).balance).toBe(500)
    expect(pos.getCustomer(customer).debt_balance).toBe(500)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(1000)
  })
  it('a daily payout retry does not consume earnings added after the first payout', () => {
    const id = randomUUID(), timestamp = new Date().toISOString(), date = timestamp.slice(0, 10)
    db.prepare("INSERT INTO staff_users (id, tenant_id, full_name, role, is_active, created_at, updated_at) VALUES (?, ?, 'Worker', 'manager', 1, ?, ?)").run(id, DEFAULT_TENANT_ID, timestamp, timestamp)
    const staff = new LocalStaffRepository(db)
    staff.createSalary({ employee_id: id, amount: 300, type: 'bonus', method: 'card', work_date: date })
    const request = { operation_id: randomUUID(), employee_id: id, method: 'card' as const, work_date: date }
    const first = staff.dailyPayout(request)
    staff.createSalary({ employee_id: id, amount: 200, type: 'bonus', method: 'card', work_date: date })
    expect(staff.dailyPayout(request)).toEqual(first)
    expect(staff.dailySummary(date).find(row => row.employee_id === id)?.balance).toBe(200)
  })
})
