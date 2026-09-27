import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'

describe('invoice editing revision', () => {
  let root: string
  let db: LocalDatabase
  let catalog: LocalCatalogRepository
  let supply: LocalSupplyRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-supply-revision-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
    supply = new LocalSupplyRepository(db)
  })
  afterEach(() => {
    vi.useRealTimers()
    db.close()
    if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-supply-revision-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })
  function fixture() {
    const product = catalog.upsertProduct({ id: randomUUID(), sku: randomUUID(), name: 'Круг тестовий', qty_on_hand: 3 })
    const invoice = supply.createInvoice({ items: [{ product_id: product.id, qty: 46, purchase_price: 1000 }] })
    return { product, invoice }
  }
  function outboxCount() {
    return db.prepare('SELECT count(*) n FROM sync_outbox').get()
  }

  it('rejects an old form after another editor changed 46 to 98 without touching stock or outbox', () => {
    const { product, invoice } = fixture()
    const changed = supply.updateInvoice(invoice.id, {
      expected_revision: invoice.edit_revision,
      items: [{ product_id: product.id, qty: 98, purchase_price: 1000 }],
    })
    const before = outboxCount()
    expect(changed.edit_revision).not.toBe(invoice.edit_revision)
    expect(() => supply.updateInvoice(invoice.id, {
      expected_revision: invoice.edit_revision,
      items: [{ product_id: product.id, qty: 46, purchase_price: 1000 }],
    })).toThrow('DOCUMENT_CONFLICT')
    expect(supply.getInvoice(invoice.id).items[0].qty).toBe(98)
    expect(catalog.findById(product.id)?.qty_on_hand).toBe(3)
    expect(outboxCount()).toEqual(before)
    supply.postInvoice(invoice.id, { expected_revision: changed.edit_revision })
    expect(catalog.findById(product.id)?.qty_on_hand).toBe(101)
  })

  it('does not post or pay a different revision from the one the user reviewed', () => {
    const { product, invoice } = fixture()
    supply.updateInvoice(invoice.id, { expected_revision: invoice.edit_revision, notes: 'Нові умови' })
    const before = outboxCount()
    expect(() => supply.postInvoice(invoice.id, { expected_revision: invoice.edit_revision })).toThrow('DOCUMENT_CONFLICT')
    expect(() => supply.payInvoice(invoice.id, {
      expected_revision: invoice.edit_revision, amount: 1000, payment_method: 'cash', fund_source: 'owner_funds',
    })).toThrow('DOCUMENT_CONFLICT')
    expect(supply.getInvoice(invoice.id).status).toBe('draft')
    expect(supply.getInvoice(invoice.id).paid_amount).toBe(0)
    expect(catalog.findById(product.id)?.qty_on_hand).toBe(3)
    expect(outboxCount()).toEqual(before)
    expect(db.prepare('SELECT count(*) n FROM supplier_payments').get()).toEqual({ n: 0 })
  })

  it('payment changes the revision, but replay of the same payment remains exactly once', () => {
    const { invoice } = fixture()
    const payment = {
      expected_revision: invoice.edit_revision, payment_id: randomUUID(), amount: 1000,
      payment_method: 'cash', fund_source: 'owner_funds',
    } as const
    const paid = supply.payInvoice(invoice.id, payment)
    expect(paid.edit_revision).not.toBe(invoice.edit_revision)
    const before = outboxCount()
    expect(supply.payInvoice(invoice.id, payment).paid_amount).toBe(1000)
    expect(outboxCount()).toEqual(before)
    expect(db.prepare('SELECT count(*) n FROM supplier_payments').get()).toEqual({ n: 1 })
    expect(() => supply.updateInvoice(invoice.id, { expected_revision: invoice.edit_revision, notes: 'Старе вікно' })).toThrow('DOCUMENT_CONFLICT')
    expect(() => supply.payInvoice(invoice.id, { ...payment, amount: 2000 })).toThrow('Ідентифікатор оплати')
  })

  it('detects updates even within the same clock tick', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-23T12:00:00.000Z'))
    const { invoice } = fixture()
    const changed = supply.updateInvoice(invoice.id, { expected_revision: invoice.edit_revision, notes: 'Змінено' })
    expect(changed.updated_at).toBe(invoice.updated_at)
    expect(changed.edit_revision).not.toBe(invoice.edit_revision)
  })

  it('does not invalidate an invoice for unrelated product display changes', () => {
    const { product, invoice } = fixture()
    db.prepare('UPDATE products SET name = ? WHERE id = ?').run('Нова назва товару', product.id)
    expect(supply.getInvoice(invoice.id).edit_revision).toBe(invoice.edit_revision)
  })

  it('does not delete or cancel a newer document from an old screen', () => {
    const { invoice } = fixture()
    const changed = supply.updateInvoice(invoice.id, { expected_revision: invoice.edit_revision, notes: 'Не втратити' })
    expect(() => supply.deleteInvoice(invoice.id, undefined, invoice.edit_revision)).toThrow('DOCUMENT_CONFLICT')
    expect(() => supply.cancelInvoice(invoice.id, undefined, invoice.edit_revision)).toThrow('DOCUMENT_CONFLICT')
    expect(supply.getInvoice(invoice.id).notes).toBe('Не втратити')
    const cancelled = supply.cancelInvoice(invoice.id, undefined, changed.edit_revision)
    const before = outboxCount()
    expect(supply.cancelInvoice(invoice.id, undefined, changed.edit_revision).status).toBe(cancelled.status)
    expect(outboxCount()).toEqual(before)
  })

  it.each(['', 'wrong', null, 123])('rejects invalid revision %s without writes', (revision) => {
    const { invoice } = fixture()
    const before = outboxCount()
    expect(() => supply.updateInvoice(invoice.id, { expected_revision: revision as string, notes: 'Не записувати' })).toThrow('DOCUMENT_CONFLICT')
    expect(outboxCount()).toEqual(before)
  })
})
