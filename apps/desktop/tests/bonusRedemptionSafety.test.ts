import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'

describe('desktop redemption cap shown by the payment screen', () => {
  let folder: string, db: LocalDatabase, pos: LocalPosRepository, customer: string, product: string, shift: string
  beforeEach(() => {
    folder = mkdtempSync(path.join(tmpdir(), 'forsage-bonus-limit-'))
    db = new LocalDatabase(folder); pos = new LocalPosRepository(db)
    shift = pos.openShift({ cashier_id: 'cashier', opening_cash: 0 })
    customer = pos.saveCustomer({ phone: '0671234567', discount_pct: 0 }).data.id
    db.prepare('UPDATE customers SET bonus_balance = 100000 WHERE id = ?').run(customer)
    product = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: randomUUID(), name: 'Synthetic bonus product', qty_on_hand: 10, retail_price: 10000, requires_core_return: true, core_deposit_amount: 20000 }).id
  })
  afterEach(() => { db.close(); if (path.dirname(folder) === tmpdir() && path.basename(folder).startsWith('forsage-bonus-limit-')) rmSync(folder, { recursive: true, force: true }) })
  function input(bonuses: number, discount = 0, price = 10000) {
    return { client_operation_id: randomUUID(), cashier_id: 'cashier', shift_id: shift, customer_id: customer, bonuses_spent: bonuses, discount: bonuses,
      items: [{ product_id: product, qty: 1, unit_price: price, discount }], payments: [{ method: 'cash' as const, amount: price + 20000 - discount - bonuses }] }
  }
  function expectUnchanged() {
    expect(db.prepare('SELECT bonus_balance AS n FROM customers WHERE id = ?').get(customer)).toEqual({ n: 100000 })
    expect(db.prepare('SELECT qty_on_hand AS n FROM products WHERE id = ?').get(product)).toEqual({ n: 10 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM sales').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM fiscal_sale_intents').get()).toEqual({ n: 0 })
  }
  // Рішення власника 20.11.2026: бонусами можна оплатити весь товар, але не заставу й не більше товару.
  it.each([[10001, 0, 10000], [9001, 1000, 10000], [104, 0, 103]])('rejects %i bonuses above the discounted goods, excluding core deposit', (bonus, discount, price) => {
    expect(() => pos.checkout(input(bonus, discount, price))).toThrow(/товарну суму/)
    expectUnchanged()
  })
  it('rejects over-cap redemption before preparing an external fiscal operation', () => {
    const checkout = input(10001)
    expect(() => pos.prepareFiscalSaleIntent({ operation_id: checkout.client_operation_id, checkout, items: [{ code: 'X', name: 'X', price: 26999, quantity: 1, amount: 26999 }], pay: { cash: 26999, card: 0, check_total: 26999 } } as any)).toThrow(/товарну суму/)
    expectUnchanged()
  })
  it.each([[3000, 0, 10000], [2700, 1000, 10000], [30, 0, 103]])('accepts exact cap %i once and preserves money-only refund', (bonus, discount, price) => {
    const request = input(bonus, discount, price)
    const sale = pos.checkout(request)
    expect(pos.checkout(request)).toEqual(sale)
    expect(db.prepare('SELECT bonus_balance AS n FROM customers WHERE id = ?').get(customer)).toEqual({ n: 100000 - bonus })
    expect(pos.getSaleForReturn(sale.sale_id).items[0].available_refund).toBe(price - discount - bonus)
    expect(db.prepare('SELECT COUNT(*) AS n FROM bonus_transactions').get()).toEqual({ n: 1 })
    const line = pos.getSaleForReturn(sale.sale_id).items[0]
    const refund = pos.createReturn({ sale_id: sale.sale_id, approved_by: 'cashier', shift_id: shift, client_operation_id: randomUUID(), items: [{ sale_item_id: line.id, product_id: product, quantity: 1 }] })
    expect(refund.refund_kopecks).toBe(price - discount - bonus)
    expect(db.prepare('SELECT bonus_balance AS n FROM customers WHERE id = ?').get(customer)).toEqual({ n: 100000 - bonus })
    expect(db.prepare('SELECT qty_on_hand AS n FROM products WHERE id = ?').get(product)).toEqual({ n: 10 })
  })
  it('lets bonuses pay the whole goods sum (owner, 20.11.2026)', () => {
    pos.checkout(input(10000))
    expect(db.prepare('SELECT bonus_balance AS n FROM customers WHERE id = ?').get(customer)).toEqual({ n: 90000 })
  })
  it.each([null, 'tier'])('accrues the personal 5%% to BONUSES, not to the customer account, with tier=%s', tier => {
    db.prepare("INSERT OR REPLACE INTO app_meta (key,value_json,updated_at) VALUES ('shop_settings',?,?)").run(JSON.stringify({ price_tiers: [{ id: 'tier', discount_pct: 10 }] }), new Date().toISOString())
    pos.saveCustomer({ discount_pct: 5, loyalty_mode: 'cashback', price_tier_id: tier }, customer)
    const sale = pos.checkout(input(0, 1000))
    expect(pos.getCustomer(customer)).toMatchObject({ deposit_balance: 0, bonus_balance: 100450 })
    expect(db.prepare('SELECT amount, transaction_type FROM bonus_transactions WHERE source_sale_id = ?').get(sale.sale_id)).toEqual({ amount: 450, transaction_type: 'earn' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM customer_deposit_transactions').get()).toEqual({ n: 0 })
  })
  it('does not accrue on the part paid with bonuses and excludes core deposits', () => {
    pos.saveCustomer({ discount_pct: 5, loyalty_mode: 'cashback' }, customer)
    pos.checkout(input(3000))
    expect(pos.getCustomer(customer)).toMatchObject({ deposit_balance: 0, bonus_balance: 97000 + 350 })
  })
  it('a return takes back the bonus earned on the returned goods, once', () => {
    pos.saveCustomer({ discount_pct: 5, loyalty_mode: 'cashback' }, customer)
    const sale = pos.checkout(input(0))
    expect(pos.getCustomer(customer)).toMatchObject({ bonus_balance: 100500 })
    const line = pos.getSaleForReturn(sale.sale_id).items[0]
    pos.createReturn({ sale_id: sale.sale_id, approved_by: 'cashier', shift_id: shift, client_operation_id: randomUUID(), items: [{ sale_item_id: line.id, product_id: product, quantity: 1 }] })
    expect(pos.getCustomer(customer)).toMatchObject({ bonus_balance: 100000, deposit_balance: 0 })
    expect(db.prepare("SELECT amount FROM bonus_transactions WHERE source_sale_id = ? AND transaction_type = 'manual'").get(sale.sale_id)).toEqual({ amount: -500 })
  })
  it('does not accrue account cashback on a debt sale', () => {
    pos.saveCustomer({ discount_pct: 5, loyalty_mode: 'cashback' }, customer)
    const request = input(0)
    pos.checkout({ ...request, payments: [{ method: 'debt', amount: 30000 }] })
    expect(pos.getCustomer(customer)).toMatchObject({ deposit_balance: 0, bonus_balance: 100000, debt_balance: 30000 })
  })
})
