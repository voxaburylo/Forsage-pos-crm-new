import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'

describe('local supply stock safety', () => {
  let root = ''
  let db: LocalDatabase
  let catalog: LocalCatalogRepository
  let supply: LocalSupplyRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-supply-stock-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
    supply = new LocalSupplyRepository(db)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-supply-stock-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function product(qty = 0) {
    return catalog.upsertProduct({
      id: randomUUID(), sku: `SUP-${randomUUID()}`, name: 'Товар накладної',
      qty_on_hand: qty, purchase_price: 100, retail_price: 150,
    })
  }

  it('fails loudly when an invoice item points to a deleted product', () => {
    const stored = product()
    const invoice = supply.createInvoice({
      items: [{ product_id: stored.id, qty: 2, purchase_price: 100 }],
    })
    catalog.deleteProduct(stored.id)

    expect(() => supply.postInvoice(invoice.id)).toThrow(/відсутній або видалений/)
    expect(supply.getInvoice(invoice.id).status).toBe('draft')
  })

  it('records an exact reversal and never clamps stock to zero', () => {
    const stored = product()
    const invoice = supply.createInvoice({
      invoice_number: 'SAFE-1',
      items: [{ product_id: stored.id, qty: 5, purchase_price: 100 }],
    })
    supply.postInvoice(invoice.id)
    db.prepare('UPDATE products SET qty_on_hand = 2 WHERE id = ?').run(stored.id)

    expect(() => supply.cancelInvoice(invoice.id)).toThrow(/вже продано або списано/)
    expect(catalog.findById(stored.id)?.qty_on_hand).toBe(2)
    expect(supply.getInvoice(invoice.id).status).toBe('posted')
  })

  it('writes a linked reversal movement when cancellation is safe', () => {
    const stored = product(1)
    const invoice = supply.createInvoice({
      items: [{ product_id: stored.id, qty: 3, purchase_price: 100 }],
    })
    supply.postInvoice(invoice.id)
    supply.cancelInvoice(invoice.id)

    expect(catalog.findById(stored.id)?.qty_on_hand).toBe(1)
    expect(db.prepare(`
      SELECT qty_delta, qty_after FROM inventory_movements
      WHERE source_type = 'supply_invoice_cancel' AND source_id = ?
    `).get(invoice.id)).toEqual({ qty_delta: -3, qty_after: 1 })
  })
  it('does not cancel an invoice that already has a payment', () => {
    const stored = product()
    const invoice = supply.createInvoice({
      items: [{ product_id: stored.id, qty: 2, purchase_price: 100 }],
    })
    supply.postInvoice(invoice.id)
    supply.payInvoice(invoice.id, {
      amount: 100,
      payment_method: 'cash',
      fund_source: 'owner_funds',
    })

    expect(() => supply.cancelInvoice(invoice.id)).toThrow(/Не можна скасувати оплачену накладну/)
    expect(supply.getInvoice(invoice.id).status).toBe('posted')
  })
})