import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { usePOSStore } from '@/stores/posStore'
import { useAuthStore } from '@/stores/authStore'
import { customerDiscountPct } from '../customers/customerDiscount'
import { parseOpenReceipts } from './cartRecovery'
import { buildFiscalSaleItems } from './fiscalSale'
import { desktopCheckoutToSale } from '@/lib/desktopBridge'
import { LocalDatabase } from '../../../../desktop/src/db/localDatabase'
import { LocalPosRepository } from '../../../../desktop/src/repositories/posRepository'
import { LocalCatalogRepository } from '../../../../desktop/src/repositories/catalogRepository'

const baseItem = { productId: 'product-1', sku: 'PART-1', name: 'Контрольний товар', unit: 'м',
  qty: 1, unitPrice: 101, discount: 0, qtyOnHand: 10 }
const customer = { id: 'customer-1', name: 'Клієнт', phone: '0671112233', debtBalance: 0,
  tierDiscountPct: 10, tierName: null, vipLevel: 'standard' as const, riskProfile: 'low' as const }
const store = usePOSStore
function reset() {
  store.getState().replaceOpenReceipts([])
  store.getState().setPriceRounding({ enabled: false })
  useAuthStore.setState({ session: { user: { app_metadata: { role: 'owner' } } } as any })
}
function chooseCustomer() {
  store.getState().setCustomer(customer)
  store.getState().setAutomaticDiscountPct(customerDiscountPct({ discount_pct: 10 } as any))
}

describe('readiness: customer discounts in every basket path', () => {
  beforeEach(reset)
  it('applies the same customer discount before or after adding a favorite/quick-access product', () => {
    chooseCustomer(); store.getState().addItem({ ...baseItem, unitPrice: 10000 })
    const before = store.getState().items[0]
    reset(); store.getState().addItem({ ...baseItem, unitPrice: 10000 }); chooseCustomer()
    expect(before).toEqual(store.getState().items[0])
    expect(before).toMatchObject({ discount: 1000, discountPct: 10, total: 9000 })
  })
  it('keeps explicit line discounts and explicit zero-percent charges on insertion', () => {
    chooseCustomer()
    store.getState().addItem({ ...baseItem, discount: 20 })
    store.getState().addItem({ ...baseItem, productId: 'charge', discountPct: 0 })
    expect(store.getState().items.map(item => item.discount)).toEqual([20, 0])
  })
  it('rounds each fractional-quantity line before computing its automatic discount', () => {
    // 22.11.2026: ціна після знижки клієнта округлюється вгору до 5 грн і не буває вищою за повну —
    // тому на рядку дешевше 5 грн автоматичної знижки немає, а копійки рядка лишаються точними.
    chooseCustomer(); store.getState().addItem({ ...baseItem, qty: 0.25, unitPrice: 102 })
    expect(store.getState().items[0]).toMatchObject({ total: 26, discount: 0 })
    expect(store.getState()).toMatchObject({ subtotal: 26, totalDiscount: 0, total: 26 })
    store.getState().updateQty(baseItem.productId, 0.333)
    expect(store.getState()).toMatchObject({ subtotal: 34, totalDiscount: 0, total: 34 })
    store.getState().addItem({ ...baseItem, qty: 0.334 })
    expect(store.getState()).toMatchObject({ subtotal: 68, totalDiscount: 0, total: 68 })
    // На звичайній ціні: 2,5 × 102 грн = 255 грн, −10 % = 229,50 → 230 грн.
    reset(); chooseCustomer(); store.getState().addItem({ ...baseItem, qty: 2.5, unitPrice: 10200 })
    expect(store.getState().items[0]).toMatchObject({ total: 23000, discount: 2500 })
  })
  it('rounds the price after a customer discount up to whole 5 UAH (owner decision 22.11.2026)', () => {
    chooseCustomer()
    store.getState().addItem({ ...baseItem, productId: 'a', unitPrice: 20500 })      // 205 − 10 % = 184,50 → 185
    store.getState().addItem({ ...baseItem, productId: 'b', unitPrice: 10000 })      // 100 − 10 % = 90 — уже кратне 5
    store.getState().addItem({ ...baseItem, productId: 'c', unitPrice: 30000, qty: 3 }) // 900 − 10 % = 810
    store.getState().addItem({ ...baseItem, productId: 'd', unitPrice: 9900 })       // 99 − 10 % = 89,10 → 90
    expect(store.getState().items.map(item => [item.productId, item.total, item.discount])).toEqual([
      ['a', 18500, 2000], ['b', 9000, 1000], ['c', 81000, 9000], ['d', 9000, 900],
    ])
    // Округлення не опускає нижче закупки і не робить ціну вищою за повну.
    reset(); chooseCustomer()
    store.getState().addItem({ ...baseItem, productId: 'cost', unitPrice: 20500, purchasePrice: 18700 })
    // 184,50 нижче закупки 187 → межа 187 → вгору до 190.
    expect(store.getState().items[0]).toMatchObject({ total: 19000, discount: 1500 })
    reset(); chooseCustomer()
    store.getState().addItem({ ...baseItem, productId: 'top', unitPrice: 20300 })     // 203 − 10 % = 182,70 → 185
    expect(store.getState().items[0]).toMatchObject({ total: 18500, discount: 1800 })
  })
  it('clamps full/manual discounts to the rounded line and keeps core deposits separate', () => {
    store.getState().addItem({ ...baseItem, qty: 0.25, unitPrice: 102, requiresCoreReturn: true, coreDepositAmount: 10 })
    store.getState().setDiscount(baseItem.productId, 1000)
    expect(store.getState()).toMatchObject({ subtotal: 26, totalDiscount: 26, totalCoreDeposit: 3, total: 3 })
    expect(store.getState().items[0].total).toBe(0)
  })
  it('does not carry redeemed bonuses over when switching or clearing the customer', () => {
    chooseCustomer(); store.getState().setBonusToRedeem(100)
    store.getState().setCustomer({ ...customer, name: 'Нова назва того самого клієнта' })
    expect(store.getState().bonusToRedeem).toBe(100)
    store.getState().setCustomer({ ...customer, id: 'customer-2' })
    expect(store.getState().bonusToRedeem).toBe(0)
    store.getState().setBonusToRedeem(200); store.getState().setCustomer(null)
    expect(store.getState().bonusToRedeem).toBe(0)
  })
  it('removes only automatic discounts when the customer is cleared', () => {
    chooseCustomer()
    store.getState().addItem({ ...baseItem, unitPrice: 10000 })
    store.getState().addItem({ ...baseItem, productId: 'manual', unitPrice: 10000, discount: 2000 })
    store.getState().setCustomer(null); store.getState().setAutomaticDiscountPct(0)
    expect(store.getState().items.map(item => item.discount)).toEqual([0, 2000])
  })
  it('keeps cents and the selected customer discount after opening a saved basket', () => {
    chooseCustomer(); store.getState().addItem({ ...baseItem, qty: 0.25, unitPrice: 102 })
    const key = store.getState().getActiveTab()!.idempotencyKey
    const saved = parseOpenReceipts(JSON.stringify({ tabs: store.getState().tabs }))
    expect(saved).not.toBeNull()
    store.getState().replaceOpenReceipts(saved!.tabs, key)
    expect(store.getState()).toMatchObject({ subtotal: 26, totalDiscount: 0, total: 26, automaticDiscountPct: 10 })
    expect(store.getState().getActiveTab()!.idempotencyKey).toBe(key)
    store.getState().addItem({ ...baseItem, productId: 'another', unitPrice: 10000 })
    expect(store.getState().items[1].discount).toBe(1000)
  })
  it('repairs old sub-kopeck basket totals without applying today\'s price-rounding setting', () => {
    const saved = parseOpenReceipts(JSON.stringify({ tabs: [{ idempotencyKey: 'operation-old-1',
      items: [{ ...baseItem, qty: 0.25, unitPrice: 102, total: 25.5 }], automaticDiscountPct: 0 }] }))
    store.getState().setPriceRounding({ enabled: true, step: 100, dir: 'up' })
    store.getState().replaceOpenReceipts(saved!.tabs)
    expect(store.getState().items[0]).toMatchObject({ unitPrice: 102, total: 26 })
    expect(store.getState().total).toBe(26)
    reset()
    expect(store.getState().restoreReceipt({ items: [{ ...baseItem, qty: 0.25, unitPrice: 102 }], customer: null })).toBe(true)
    expect(store.getState().total).toBe(26)
  })
  it.each([NaN, Infinity, -Infinity])('rejects non-finite edits without corrupting a basket (%s)', value => {
    chooseCustomer(); store.getState().addItem(baseItem)
    const before = store.getState().items
    store.getState().updateQty(baseItem.productId, value)
    store.getState().setDiscount(baseItem.productId, value)
    store.getState().setAutomaticDiscountPct(value)
    expect(store.getState().items).toEqual(before)
    expect(Number.isInteger(store.getState().total)).toBe(true)
  })
})

describe('readiness: fiscal line discount identity', () => {
  it('does not spread one product\'s discount onto another product', () => {
    const lines = buildFiscalSaleItems([
      { ...baseItem, unitPrice: 10000, discount: 1000 },
      { ...baseItem, unitPrice: 5000, discount: 0 },
    ], 1000)
    expect(lines.map(item => item.amount)).toEqual([9000, 5000])
    expect(lines.map(item => item.discount)).toEqual([1000, 0])
  })
  it('spreads only an extra receipt discount over the already discounted amounts', () => {
    const lines = buildFiscalSaleItems([
      { ...baseItem, unitPrice: 10000, discount: 1000 },
      { ...baseItem, unitPrice: 5000, discount: 0 },
    ], 2400)
    expect(lines.map(item => item.amount)).toEqual([8100, 4500])
    expect(lines.map(item => item.discount)).toEqual([1900, 500])
  })
})

describe('readiness: basket → isolated local sale → restart → return', () => {
  let root: string, db: LocalDatabase, pos: LocalPosRepository, shift: string
  beforeEach(() => {
    reset(); root = mkdtempSync(path.join(tmpdir(), 'forsage-discount-flow-'))
    db = new LocalDatabase(root); pos = new LocalPosRepository(db)
    shift = pos.openShift({ cashier_id: 'cashier', opening_cash: 10000 })
  })
  afterEach(() => {
    db.close()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-discount-flow-')) rmSync(root, { recursive: true, force: true })
  })
  function product(qty: number, unitPrice: number, core = 0) {
    const p = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: randomUUID(), name: 'Контрольний товар',
      unit: 'м', qty_on_hand: 10, retail_price: unitPrice, requires_core_return: core > 0, core_deposit_amount: core })
    store.getState().addItem({ ...baseItem, productId: p.id, sku: p.sku, qty, unitPrice, requiresCoreReturn: core > 0, coreDepositAmount: core })
    return p.id
  }
  function localCustomer(discount = 10, mode: 'discount' | 'cashback' = 'discount') {
    const card = pos.saveCustomer({ full_name: 'Клієнт перевірки', phone: '0671112233', discount_pct: discount, loyalty_mode: mode }).data
    const pct = customerDiscountPct(card as any)
    store.getState().setCustomer({ ...customer, id: card.id, tierDiscountPct: pct })
    store.getState().setAutomaticDiscountPct(pct)
    return card.id
  }
  function pay(extraDiscount = 0, bonusesSpent = 0) {
    const basket = store.getState()
    const input = { client_operation_id: basket.getActiveTab()!.idempotencyKey, cashier_id: 'cashier', shift_id: shift,
      items: basket.items.map(item => ({ product_id: item.productId, qty: item.qty, unit_price: item.unitPrice, discount: item.discount })),
      customer_id: basket.customer?.id, bonuses_spent: bonusesSpent,
      discount: extraDiscount, payments: [{ method: 'cash' as const, amount: basket.total - extraDiscount }] }
    const result = pos.checkout(input)
    expect(pos.checkout(input)).toEqual(result)
    const printed = desktopCheckoutToSale(result, input, basket.items.map(item => ({
      id: item.productId, product_id: item.productId, qty: item.qty, unit_price: item.unitPrice, discount: item.discount, total: item.total,
    })))
    expect(printed.discount).toBe(basket.totalDiscount + extraDiscount)
    expect(printed.total).toBe(basket.total - extraDiscount)
    db.close(); db = new LocalDatabase(root); pos = new LocalPosRepository(db)
    return result.sale_id
  }
  it('pays a fractional discounted basket once and returns the exact charged product amount', () => {
    localCustomer(); const id = product(0.25, 102)
    const sale = pay()
    expect(pos.getSale(sale)).toMatchObject({ subtotal: 26, discount: 0, total: 26 })
    const item = pos.getSaleForReturn(sale).items[0]
    expect(item.available_refund).toBe(26)
    const request = { sale_id: sale, approved_by: 'cashier', shift_id: shift, client_operation_id: randomUUID(),
      items: [{ sale_item_id: item.id, product_id: id, quantity: 0.25 }] }
    expect(pos.createReturn(request).refund_kopecks).toBe(26)
    expect(pos.createReturn(request).refund_kopecks).toBe(26)
    expect(pos.getExpectedCash('cashier')!.expected_amount).toBe(10000)
    expect(db.prepare('SELECT qty_on_hand n FROM products WHERE id=?').get(id)).toEqual({ n: 10 })
  })
  it('keeps line rounding when all fractional products are returned', () => {
    const ids = [product(0.25, 102), product(0.25, 102)]
    const sale = pay()
    const items = pos.getSaleForReturn(sale).items
    expect(items.map((item: any) => item.available_refund)).toEqual([26, 26])
    for (const item of items) {
      expect(pos.createReturn({ sale_id: sale, approved_by: 'cashier', shift_id: shift, client_operation_id: randomUUID(),
        items: [{ sale_item_id: item.id, product_id: item.product_id, quantity: 0.25 }] }).refund_kopecks).toBe(26)
    }
    expect(pos.getExpectedCash('cashier')!.expected_amount).toBe(10000)
    for (const id of ids) expect(db.prepare('SELECT qty_on_hand n FROM products WHERE id=?').get(id)).toEqual({ n: 10 })
  })
  it('excludes separately rounded core deposits from product refunds', () => {
    product(0.25, 102, 10); product(0.25, 102, 10)
    const sale = pay()
    expect(pos.getSale(sale).total).toBe(58)
    const returns = pos.getSaleForReturn(sale)
    expect(returns.items.map((item: any) => item.available_refund)).toEqual([26, 26])
  })
  it('reads a saved personal discount, spends bonuses once and refunds no more than the paid money', () => {
    const client = localCustomer(7.25)
    db.prepare('UPDATE customers SET bonus_balance=5000 WHERE id=?').run(client)
    const id = product(3, 10000)
    // 300 грн − 7,25 % = 278,25 → 280 грн (округлення вгору до 5 грн).
    expect(store.getState().total).toBe(28000)
    const sale = pay(3000, 3000)
    expect(db.prepare('SELECT bonus_balance n FROM customers WHERE id=?').get(client)).toEqual({ n: 2000 })
    expect(db.prepare('SELECT COUNT(*) n FROM bonus_transactions WHERE customer_id=?').get(client)).toEqual({ n: 1 })
    const line = pos.getSaleForReturn(sale).items[0]
    // Сплачено грошима 280 − 30 бонусів = 250 грн; три повернення разом — рівно 250, не більше.
    const refunds = [0, 1, 2].map(() => pos.createReturn({ sale_id: sale, approved_by: 'cashier', shift_id: shift, client_operation_id: randomUUID(),
      items: [{ sale_item_id: line.id, product_id: id, quantity: 1 }] }).refund_kopecks)
    expect(refunds.reduce((sum, value) => sum + value, 0)).toBe(25000)
    expect(Math.max(...refunds) - Math.min(...refunds)).toBeLessThanOrEqual(1)
    expect(pos.getExpectedCash('cashier')!.expected_amount).toBe(10000)
  })
  it('does not apply cashback as an immediate discount or accrue it on a core deposit; it goes to bonuses', () => {
    const client = localCustomer(10, 'cashback')
    product(1, 10000, 20000)
    const sale = pay()
    expect(pos.getSale(sale)).toMatchObject({ discount: 0, total: 30000 })
    // Рішення власника 20.11.2026: накопичення йде в бонуси, рахунок клієнта (передоплата) не змінюється.
    expect(db.prepare('SELECT deposit_balance d, bonus_balance b FROM customers WHERE id=?').get(client)).toEqual({ d: 0, b: 1000 })
  })
  it('rejects a bonus debit missing its matching receipt discount before changing any money or stock', () => {
    const client = localCustomer(0)
    db.prepare('UPDATE customers SET bonus_balance=5000 WHERE id=?').run(client)
    const id = product(1, 10000)
    expect(() => pos.checkout({ cashier_id: 'cashier', shift_id: shift, customer_id: client, bonuses_spent: 1000,
      items: [{ product_id: id, qty: 1, unit_price: 10000 }], payments: [{ method: 'cash', amount: 10000 }] })).toThrow()
    expect(db.prepare('SELECT bonus_balance n FROM customers WHERE id=?').get(client)).toEqual({ n: 5000 })
    expect(db.prepare('SELECT qty_on_hand n FROM products WHERE id=?').get(id)).toEqual({ n: 10 })
    expect(db.prepare('SELECT COUNT(*) n FROM sales').get()).toEqual({ n: 0 })
  })
  it('preserves individual discounts in both fiscal output and a receipt-wide discounted return', () => {
    const first = product(1, 10000); product(1, 5000)
    store.getState().setDiscount(first, 1000)
    const fiscal = buildFiscalSaleItems(store.getState().items, 2400)
    const sale = pay(1400)
    expect(pos.getSaleForReturn(sale).items.map((item: any) => item.available_refund)).toEqual(fiscal.map(item => item.amount))
  })
})
