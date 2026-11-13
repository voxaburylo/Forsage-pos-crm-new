import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'

describe('local till: nothing is sold below the purchase price', () => {
  let root = ''
  let db: LocalDatabase
  let pos: LocalPosRepository
  let shift = ''

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-cost-floor-'))
    db = new LocalDatabase(root)
    pos = new LocalPosRepository(db)
    shift = pos.openShift({ cashier_id: 'cashier', opening_cash: 0 })
  })
  afterEach(() => {
    db.close()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-cost-floor-')) rmSync(root, { recursive: true, force: true })
  })

  // Закупка 5000 грн, продаж 6500 грн.
  function part(retail = 650_000, purchase = 500_000) {
    return new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: randomUUID(), name: 'Амортизатор',
      qty_on_hand: 10, purchase_price: purchase, retail_price: retail })
  }
  function sale(productId: string, lineDiscount: number, receiptDiscount = 0, unitPrice = 650_000) {
    return { cashier_id: 'cashier', shift_id: shift, client_operation_id: randomUUID(),
      items: [{ product_id: productId, qty: 1, unit_price: unitPrice, discount: lineDiscount }],
      discount: receiptDiscount, payments: [{ method: 'cash' as const, amount: unitPrice - lineDiscount - receiptDiscount }] }
  }
  const untouched = (id: string) => {
    expect(db.prepare('SELECT COUNT(*) n FROM sales').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT qty_on_hand n FROM products WHERE id=?').get(id)).toEqual({ n: 10 })
  }

  it('rejects a 30% discount that would sell at 4550 and names the product', () => {
    const p = part()
    expect(() => pos.checkout(sale(p.id, 195_000))).toThrow(/Амортизатор.*нижче закупівельної/)
    untouched(p.id)
  })
  it('sells exactly at cost and above it', () => {
    const p = part()
    expect(pos.getSale(pos.checkout(sale(p.id, 150_000)).sale_id).total).toBe(500_000)
    expect(pos.getSale(pos.checkout(sale(p.id, 0)).sale_id).total).toBe(650_000)
  })
  it('rejects a receipt-level discount (bonuses) that goes below cost', () => {
    const p = part()
    expect(() => pos.checkout(sale(p.id, 100_000, 60_000))).toThrow(/нижче закупівельної вартості/)
    untouched(p.id)
  })
  it('rejects a retail price that is itself below the purchase price', () => {
    const p = part(400_000, 500_000)
    expect(() => pos.checkout(sale(p.id, 0, 0, 400_000))).toThrow(/нижче закупівельної/)
    untouched(p.id)
  })
  it('does not limit products without a purchase price', () => {
    const p = part(10_000, 0)
    expect(pos.getSale(pos.checkout(sale(p.id, 9_000, 0, 10_000)).sale_id).total).toBe(1_000)
  })
})
