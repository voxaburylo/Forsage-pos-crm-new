import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { attachBalanceSnapshots } from '../src/repositories/balanceSnapshot'
let root: string, db: LocalDatabase, pos: LocalPosRepository, source: string, target: string, actor: string, shift: string, sale: string, line: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-cleanup-return-')); db = new LocalDatabase(root); pos = new LocalPosRepository(db)
  const catalog = new LocalCatalogRepository(db)
  source = catalog.upsertProduct({ id: randomUUID(), sku: 'old', name: 'Тест', qty_on_hand: 2, purchase_price: 50, retail_price: 100 }).id
  target = catalog.upsertProduct({ id: randomUUID(), sku: 'current', name: 'Тест', qty_on_hand: 3, purchase_price: 75, retail_price: 150 }).id
  actor = randomUUID(); shift = pos.openShift({ cashier_id: actor, opening_cash: 1000 })
  sale = pos.checkout({ cashier_id: actor, shift_id: shift, items: [{ product_id: source, qty: 1, unit_price: 100 }], payments: [{ method: 'cash', amount: 100 }] }).sale_id
  line = pos.getSaleForReturn(sale).items[0].id
  db.prepare('UPDATE products SET qty_on_hand=0,is_active=0,deleted_at=?,specs_json=? WHERE id=?')
    .run(new Date().toISOString(), JSON.stringify({ merged_into_product_id: target }), source)
  db.prepare('UPDATE products SET qty_on_hand=4 WHERE id=?').run(target)
})
afterEach(() => { db.close(); if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-cleanup-return-')) rmSync(root, { recursive: true, force: true }) })
const request = () => ({ sale_id: sale, approved_by: actor, shift_id: shift, client_operation_id: randomUUID(),
  items: [{ sale_item_id: line, product_id: source, quantity: 1 }] })
it('returns to canonical stock while keeping original receipt, price and return references', () => {
  const before = db.prepare('SELECT * FROM sale_items WHERE id=?').get(line)
  const input = request(), result = pos.createReturn(input)
  expect(pos.createReturn(input).id).toBe(result.id)
  expect(db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get(source)).toEqual({ qty_on_hand: 0 })
  expect(db.prepare('SELECT qty_on_hand FROM products WHERE id=?').get(target)).toEqual({ qty_on_hand: 5 })
  expect(db.prepare('SELECT * FROM sale_items WHERE id=?').get(line)).toEqual(before)
  expect(db.prepare('SELECT product_id,total_kopecks FROM customer_return_items WHERE return_id=?').get(result.id)).toEqual({ product_id: source, total_kopecks: 100 })
  expect(db.prepare("SELECT product_id,unit_cost FROM inventory_movements WHERE source_type='customer_return'").get()).toEqual({ product_id: target, unit_cost: 50 })
  const op = db.prepare("SELECT * FROM sync_outbox WHERE operation_type='return.created'").get() as any
  const copy = attachBalanceSnapshots(db, [{ ...op, payload: JSON.parse(op.payload_json) }])[0]
  expect(copy.payload.local_balance_snapshot.products).toEqual(expect.arrayContaining([{ id: target, qty_on_hand: 5 }, { id: source, qty_on_hand: 0 }]))
})
it('rejects broken/cyclic canonical references atomically', () => {
  db.prepare('UPDATE products SET specs_json=?,deleted_at=?,is_active=0 WHERE id=?').run(JSON.stringify({ merged_into_product_id: source }), new Date().toISOString(), target)
  expect(() => pos.createReturn(request())).toThrow()
  expect(db.prepare('SELECT COUNT(*) n FROM customer_returns').get()).toEqual({ n: 0 })
  expect(pos.getExpectedCash(actor)?.expected_amount).toBe(1100)
})
