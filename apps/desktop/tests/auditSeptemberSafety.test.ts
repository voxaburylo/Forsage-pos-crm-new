import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalOrderRepository } from '../src/repositories/orderRepository'

describe('September audit financial boundaries and order search', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository, orders: LocalOrderRepository, cashier: string, shift: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-september-audit-'))
    db = new LocalDatabase(root); pos = new LocalPosRepository(db); orders = new LocalOrderRepository(db)
    cashier = randomUUID()
    const ts = new Date().toISOString()
    db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(cashier, DEFAULT_TENANT_ID, 'Тест', 'cashier', ts, ts)
    shift = pos.openShift({ cashier_id: cashier, opening_cash: 10000 })
  })
  afterEach(() => {
    vi.restoreAllMocks(); db.close()
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-september-audit-')) rmSync(root, { recursive: true, force: true })
  })
  it('replays the exact closed shift across restart without closing the next one', () => {
    const first = pos.closeShift(cashier, 10000, null, shift)
    db.close(); db = new LocalDatabase(root); pos = new LocalPosRepository(db)
    const next = pos.openShift({ cashier_id: cashier, opening_cash: 20000 })
    expect(pos.closeShift(cashier, 10000, null, shift)).toEqual(first)
    expect(pos.getOpenShift(cashier)?.id).toBe(next)
    expect(() => pos.closeShift(cashier, 1, null, shift)).toThrow('інші дані')
    expect(() => pos.closeShift(randomUUID(), 10000, null, shift)).toThrow()
    expect(db.prepare('SELECT count(*) n FROM shift_backups').get()).toEqual({ n: 1 })
  })
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '' as unknown as number])('rejects malformed cash %s without closing', (amount) => {
    expect(() => pos.closeShift(cashier, amount, null, shift)).toThrow()
    expect(() => pos.reconcileShift(cashier, amount, null)).toThrow()
    expect(() => pos.openShift({ cashier_id: cashier, opening_cash: amount })).toThrow()
    expect(pos.getOpenShift(cashier)?.id).toBe(shift)
  })
  it('refuses a missing/wrong shift identity', () => {
    expect(() => pos.closeShift(cashier, 10000, null, '')).toThrow()
    expect(() => pos.closeShift(cashier, 10000, null, randomUUID())).toThrow()
    expect(pos.getOpenShift(cashier)?.id).toBe(shift)
  })
  function pay(orderId: string, extra = {}) {
    return orders.addPayment(orderId, { user_id: cashier, shift_id: shift, amount: 1000, method: 'cash', ...extra })
  }
  it('rechecks cash totals at the trusted boundary, requiring an owner explanation for a large variance', () => {
    expect(() => pos.closeShift(cashier, 0, null, shift)).toThrow('не сходиться')
    expect(() => pos.closeShift(cashier, 0, null, shift, DEFAULT_TENANT_ID, 'owner')).toThrow('коментар')
    expect(pos.closeShift(cashier, 0, 'Перерахунок власником', shift, DEFAULT_TENANT_ID, 'owner').id).toBe(shift)
  })
  it('accepts several advances before pricing, without taking cash twice on retry', () => {
    const order = orders.saveOrder({ status: 'lead', items: [] })
    const payment_id = randomUUID()
    pay(order.id, { amount: 5000, payment_id })
    pay(order.id, { amount: 5000, payment_id })
    const second = pay(order.id)
    expect(second.order.total_paid).toBe(6000)
    expect(second.order.status).toBe('lead')
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(16000)
    expect(orders.listPayments(order.id)).toHaveLength(2)
    expect(() => pay(order.id, { amount: 5000, payment_id, method: 'card' })).toThrow()
    expect(() => pay(order.id, { amount: 5000, payment_id, shift_id: randomUUID() })).toThrow()
    expect(() => pay(order.id, { amount: 5000, payment_id, is_fiscal: true })).toThrow()
  })
  it('supports old unpriced drafts promoted to new but blocks priced/discounted overpayment', () => {
    const old = orders.saveOrder({ status: 'new', items: [] })
    db.prepare("UPDATE customer_orders SET status='new' WHERE id=?").run(old.id)
    pay(old.id); expect(pay(old.id).order.total_paid).toBe(2000)
    const priced = orders.saveOrder({ status: 'lead', items: [{ name: 'Фільтр', source_type: 'supplier', qty: 1, sell_price: 1000 }] })
    pay(priced.id)
    expect(() => pay(priced.id)).toThrow('перевищує')
    db.prepare("UPDATE customer_orders SET status='lead',discount_amount=total_amount,total_paid=0 WHERE id=?").run(priced.id)
    expect(() => pay(priced.id)).toThrow('перевищує')
    db.prepare("UPDATE customer_orders SET status='canceled' WHERE id=?").run(old.id)
    expect(() => pay(old.id)).toThrow('скасоване')
  })
  it.each([NaN, Infinity, -1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects malformed payment %s atomically', (amount) => {
    const order = orders.saveOrder({ items: [] })
    expect(() => pay(order.id, { amount })).toThrow()
    expect(orders.listPayments(order.id)).toHaveLength(0)
    expect(orders.getOrder(order.id).total_paid).toBe(0)
  })
  it('rejects unknown payment methods without a ledger or order change', () => {
    const order = orders.saveOrder({ items: [] })
    expect(() => pay(order.id, { method: 'unknown' })).toThrow('спосіб')
    expect(orders.listPayments(order.id)).toHaveLength(0)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(10000)
  })
  it('finds Cyrillic item/client names regardless of case and treats wildcards literally', () => {
    const customer = pos.saveCustomer({ phone: '0500000000', full_name: 'ІВАН Петренко' }).data.id
    const order = orders.saveOrder({ customer_id: customer, items: [{ name: 'Фільтр Масляний', sku: 'АБ-123', qty: 1, sell_price: 1000, source_type: 'supplier' }] })
    for (const search of ['Фільтр', 'фільтр', 'ФІЛЬТР', 'МАСЛЯНИЙ', 'аб-123', 'іван', 'ПЕТРЕНКО']) {
      expect(orders.listOrders({ search }).map((row) => row.id)).toContain(order.id)
    }
    expect(orders.listReadyOrders({ search: 'іван' }).map((row) => row.id)).toContain(order.id)
    expect(orders.listOrders({ search: '%' })).toHaveLength(0)
    expect(orders.listOrders({ tenant_id: randomUUID(), search: 'фільтр' })).toHaveLength(0)
  })
  it('loads order items in one bounded query instead of one per order', () => {
    for (let i = 0; i < 3; i++) orders.saveOrder({ items: [{ name: 'Part', qty: 1, sell_price: 1000, source_type: 'supplier' }] })
    const spy = vi.spyOn(db, 'prepare')
    expect(orders.listOrders()).toHaveLength(3)
    expect(spy).toHaveBeenCalledTimes(2)
  })
  it.each([1.5, NaN, Infinity, -20])('bounds malformed paging values %s before SQLite', (value) => {
    orders.saveOrder({ items: [] })
    expect(() => orders.listOrders({ limit: value, offset: value })).not.toThrow()
    expect(() => orders.listReadyOrders({ limit: value })).not.toThrow()
  })
  it('preserves entered line order in both detail and batch reads', () => {
    const order = orders.saveOrder({ items: [
      { id: 'ffffffff-0000-4000-8000-000000000001', name: 'First', qty: 1, sell_price: 100, source_type: 'supplier' },
      { id: '00000000-0000-4000-8000-000000000002', name: 'Second', qty: 1, sell_price: 100, source_type: 'supplier' },
    ] })
    const names = (value: any) => value.items.map((item: any) => item.name)
    expect(names(orders.getOrder(order.id))).toEqual(['First', 'Second'])
    expect(names(orders.listOrders()[0])).toEqual(['First', 'Second'])
    expect(names(orders.listReadyOrders()[0])).toEqual(['First', 'Second'])
  })
})
