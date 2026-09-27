import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import type { LocalSaleCheckoutInput } from '../src/db/localTypes'
let root: string, db: LocalDatabase, pos: LocalPosRepository, input: LocalSaleCheckoutInput, productId: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-checkout-validation-'))
  db = new LocalDatabase(root); pos = new LocalPosRepository(db)
  const cashier = randomUUID(), shift = pos.openShift({ cashier_id: cashier, opening_cash: 0 })
  productId = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: randomUUID(), name: 'Тест', qty_on_hand: 10, retail_price: 100 }).id
  input = { cashier_id: cashier, shift_id: shift, items: [{ product_id: productId, qty: 1, unit_price: 100 }], payments: [{ method: 'cash', amount: 100 }] }
})
afterEach(() => {
  db.close()
  if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-checkout-validation-')) rmSync(root, { recursive: true, force: true })
})
it.each([NaN, Infinity, -1, 101])('rejects invalid receipt discount %s without stock or money changes', discount => {
  input.discount = discount
  input.payments[0].amount = Math.max(0, 100 - (Number.isFinite(discount) ? discount : 0))
  expect(() => pos.checkout(input)).toThrow('LOCAL_SALE_INVALID_DISCOUNT')
  expect(db.prepare('SELECT qty_on_hand n FROM products WHERE id=?').get(productId)).toEqual({ n: 10 })
  expect(db.prepare('SELECT count(*) n FROM sales').get()).toEqual({ n: 0 })
})
it('rejects negative split payment even if the final sum matches', () => {
  input.payments = [{ method: 'cash', amount: -100 }, { method: 'card', amount: 200 }]
  expect(() => pos.checkout(input)).toThrow('LOCAL_SALE_INVALID_AMOUNT')
})
it('does not create debt without a customer', () => {
  input.payments = [{ method: 'debt', amount: 100 }]
  expect(() => pos.checkout(input)).toThrow('виберіть клієнта')
})
it('checks a closed shift inside the write transaction', () => {
  pos.closeShift(input.cashier_id, 0, null, input.shift_id!)
  expect(() => pos.checkout(input)).toThrow('LOCAL_OPEN_SHIFT_REQUIRED')
})
it('allows an explicit full discount and preserves a valid idempotent retry', () => {
  input.client_operation_id = randomUUID(); input.discount = 100; input.payments[0].amount = 0
  const first = pos.checkout(input)
  expect(pos.checkout(input)).toEqual(first)
  expect(db.prepare('SELECT qty_on_hand n FROM products WHERE id=?').get(productId)).toEqual({ n: 9 })
  expect(() => pos.checkout({ ...input, discount: NaN })).toThrow('LOCAL_SALE_INVALID_DISCOUNT')
})
