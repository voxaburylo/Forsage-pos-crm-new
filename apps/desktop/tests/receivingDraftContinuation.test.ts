import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import { commitReceiving, type ReceivingLine } from '../src/repositories/receivingCommit'

describe('continuing a paid receiving draft on isolated SQLite', () => {
  let root: string, db: LocalDatabase, catalog: LocalCatalogRepository, supply: LocalSupplyRepository
  let supplier: string, product: string, removed: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-draft-continuation-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
    supply = new LocalSupplyRepository(db)
    supplier = supply.saveSupplier({ name: 'Синтетичний постачальник' }).id
    product = catalog.saveProduct({ id: randomUUID(), name: 'Залишити', sku: 'KEEP', qty_on_hand: 5, purchase_price: 10000, retail_price: 15000 }).id
    removed = catalog.saveProduct({ id: randomUUID(), name: 'Прибрати', sku: 'REMOVE', qty_on_hand: 7, purchase_price: 5000, retail_price: 7500 }).id
  })
  afterEach(() => {
    db.close()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-draft-continuation-')) rmSync(root, { recursive: true, force: true })
  })
  function draft() {
    const invoice = supply.createInvoice({ supplier_id: supplier, items: [{ product_id: product, qty: 2, purchase_price: 10000 }, { product_id: removed, qty: 1, purchase_price: 5000 }] })
    return supply.payInvoice(invoice.id, { amount: 5000, payment_method: 'cash', fund_source: 'owner_funds', payment_id: randomUUID(), expected_revision: invoice.edit_revision })
  }
  function row(overrides: Partial<ReceivingLine> = {}): ReceivingLine {
    return { client_key: randomUUID(), product_id: product, product_name: 'Залишити', sku: 'KEEP', qty: 2, purchase_price: 10000, retail_price: 15000, ...overrides }
  }
  function snapshot() {
    return Object.fromEntries(['products', 'supply_invoices', 'supply_invoice_items', 'supplier_payments', 'inventory_movements', 'sync_outbox']
      .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
  }
  it('adds/removes lines under the same ID; keeps existing payment and posts stock once', () => {
    const original = draft()
    const payments = db.prepare('SELECT * FROM supplier_payments ORDER BY rowid').all()
    const input = { invoice_id: original.id, operation_id: randomUUID(), expected_revision: original.edit_revision, supplier_id: supplier,
      items: [row({ qty: 3 }), row({ product_id: undefined, is_new: true, sku: 'NEW', product_name: 'Доданий', qty: 4, purchase_price: 2500, retail_price: 4000 })], payments: [] }
    const saved = commitReceiving(db, input)
    expect(saved).toMatchObject({ id: original.id, status: 'posted', paid_amount: 5000, total: 40000 })
    expect(saved.items.map((item: any) => item.product_id)).not.toContain(removed)
    expect(catalog.findById(product)?.qty_on_hand).toBe(8)
    expect(catalog.findById(removed)?.qty_on_hand).toBe(7)
    expect(catalog.findBySku('NEW')?.qty_on_hand).toBe(4)
    expect(db.prepare('SELECT * FROM supplier_payments ORDER BY rowid').all()).toEqual(payments)
    const before = snapshot()
    expect(commitReceiving(db, input).id).toBe(original.id)
    expect(snapshot()).toEqual(before)
    expect(() => commitReceiving(db, { ...input, operation_id: randomUUID(), expected_revision: saved.edit_revision })).toThrow('DOCUMENT_CONFLICT')
    expect(snapshot()).toEqual(before)
  })
  it('rejects reducing total below prior payment atomically without changing stock or cards', () => {
    const original = draft(), before = snapshot()
    expect(() => commitReceiving(db, { invoice_id: original.id, operation_id: randomUUID(), expected_revision: original.edit_revision, supplier_id: supplier,
      items: [row({ qty: 1, purchase_price: 1000 })], payments: [] })).toThrow('менша за вже внесену оплату')
    expect(snapshot()).toEqual(before)
  })
})
