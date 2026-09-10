import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalPurchaseRepository } from '../src/repositories/localPurchaseRepository'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'

describe('local purchase planning', () => {
  let root: string, db: LocalDatabase, purchases: LocalPurchaseRepository, product: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-local-purchase-'))
    db = new LocalDatabase(root); purchases = new LocalPurchaseRepository(db)
    product = new LocalCatalogRepository(db).upsertProduct({ id: randomUUID(), sku: randomUUID(), name: 'Filter', purchase_price: 2500, qty_on_hand: 2 }).id
  })
  afterEach(() => {
    db.close()
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-local-purchase-')) rmSync(root, { recursive: true, force: true })
  })
  it('creates local drafts without paying or changing stock and excludes pending quantities on the next run', () => {
    purchases.createRule({ product_id: product, min_qty: 5, max_qty: 10 })
    expect(purchases.suggestions()[0].suggest_qty).toBe(8)
    const input = { operation_id: randomUUID() }
    const first = purchases.generateInvoices(input)
    expect(first.count).toBe(1)
    expect(first.invoices[0]).toMatchObject({ status: 'draft', paid_amount: 0, total: 20000 })
    expect(db.prepare('SELECT qty_on_hand qty FROM products WHERE id = ?').get(product)).toEqual({ qty: 2 })
    expect(purchases.suggestions()).toEqual([])
    expect(purchases.generateInvoices(input)).toEqual(first)
    expect(purchases.generateInvoices({ operation_id: randomUUID() }).count).toBe(0)
    expect(db.prepare('SELECT count(*) n FROM supply_invoices').get()).toEqual({ n: 1 })
  })
  it('does not duplicate rules on retry, but refuses a conflicting second rule', () => {
    const input = { product_id: product, min_qty: 5, max_qty: 10 }
    const first = purchases.createRule(input)
    expect(purchases.createRule(input).id).toBe(first.id)
    expect(() => purchases.createRule({ ...input, max_qty: 12 })).toThrow('вже існує')
    expect(purchases.listRules()).toHaveLength(1)
    purchases.deleteRule(first.id); purchases.deleteRule(first.id)
    expect(purchases.listRules()).toHaveLength(0)
  })
  it.each([NaN, Infinity, -1, 0])('refuses invalid bounds %s', value => {
    expect(() => purchases.createRule({ product_id: product, min_qty: value, max_qty: 10 })).toThrow('мінімум')
  })
  it('rolls back generated drafts and retry receipt when an outbox write fails', () => {
    purchases.createRule({ product_id: product, min_qty: 5, max_qty: 10 })
    const input = { operation_id: randomUUID() }
    db.exec("CREATE TRIGGER fail_purchase BEFORE INSERT ON sync_outbox WHEN NEW.operation_type = 'supplier_invoice.created' BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    expect(() => purchases.generateInvoices(input)).toThrow('test failure')
    expect(db.prepare('SELECT count(*) n FROM supply_invoices').get()).toEqual({ n: 0 })
    db.exec('DROP TRIGGER fail_purchase')
    expect(purchases.generateInvoices(input).count).toBe(1)
  })
  it('shows supplier rows without a catalog card and follows their actual order status', () => {
    const orders = new LocalOrderRepository(db)
    const order = orders.saveOrder({ manager_id: randomUUID(), items: [{ name: 'Part ordered manually', sku: 'ABC-1', qty: 2, sell_price: 500, source_type: 'supplier' }] })
    const groups = purchases.supplierNeeds()
    expect(groups).toHaveLength(1)
    expect(groups[0].items[0].product.name).toBe('Part ordered manually')
    orders.updateOrderItemStatus(order.id, order.items[0].id, 'ordered')
    expect(purchases.supplierNeeds()[0].status).toBe('ordered')
    orders.updateOrderItemStatus(order.id, order.items[0].id, 'arrived')
    expect(purchases.supplierNeeds()[0].status).toBe('received')
  })
  it('isolates tenant rules and reserves purchase writes for office roles', () => {
    purchases.createRule({ product_id: product, min_qty: 5, max_qty: 10 })
    expect(purchases.listRules(randomUUID())).toEqual([])
    expect(purchases.suggestions(DEFAULT_TENANT_ID)).toHaveLength(1)
    expect(isDesktopChannelAllowed('desktop:purchases:generate-invoices', 'cashier')).toBe(false)
    expect(isDesktopChannelAllowed('desktop:purchases:generate-invoices', 'manager')).toBe(true)
  })
})
