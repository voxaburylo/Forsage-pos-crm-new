import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import type { LocalDatabase } from '../src/db/localDatabase'
let db: DatabaseSync
let repo: LocalSupplyRepository
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.function('forsage_lower', value => String(value ?? '').toLocaleLowerCase('uk-UA'))
  db.exec(`CREATE TABLE suppliers(id TEXT, tenant_id TEXT, name TEXT, contact_name TEXT, phone TEXT, email TEXT, notes TEXT, is_active INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE products(id TEXT, tenant_id TEXT, name TEXT, sku TEXT, barcode TEXT, deleted_at TEXT);
    CREATE TABLE supply_invoices(id TEXT, tenant_id TEXT, supplier_id TEXT, status TEXT, deleted_at TEXT, created_at TEXT);
    CREATE TABLE supply_invoice_items(invoice_id TEXT, tenant_id TEXT, product_id TEXT, deleted_at TEXT);
    INSERT INTO products VALUES('p','shop','Фільтр Масляний WIX','WA9428','5449000351081','archived'),('x','other','Фільтр Масляний','WA9428','5449000351081',NULL),('lit','shop','100%_test','LIT','123',NULL);
    INSERT INTO suppliers VALUES('s','shop','АвтоКомфорт',NULL,'0501234567',NULL,NULL,1,'now','now',NULL),('x','other','АвтоКомфорт',NULL,NULL,NULL,NULL,1,'now','now',NULL);
    INSERT INTO supply_invoices VALUES('draft','shop','s','draft',NULL,'2026-01-01'),('other','other','s','posted',NULL,'2026-01-01'),('gone','shop','s','posted','deleted','2026-01-01');
    INSERT INTO products VALUES('belt','shop','Новий ремінь','BELT','999',NULL);
    INSERT INTO supply_invoice_items VALUES('draft','shop','belt',NULL);
    INSERT INTO supply_invoice_items VALUES('other','other','p',NULL),('gone','shop','p',NULL);`)
  for (let i = 0; i < 25; i++) {
    const id = 'i-' + String(i).padStart(2, '0')
    db.prepare("INSERT INTO supply_invoices VALUES(?,'shop','s','posted',NULL,'2026-01-01')").run(id)
    db.prepare("INSERT INTO supply_invoice_items VALUES(?,'shop','p',NULL)").run(id)
  }
  db.exec("INSERT INTO supply_invoice_items VALUES('i-24','shop','p',NULL),('draft','shop','x',NULL),('draft','shop','p','deleted'),('i-23','shop','lit',NULL)")
  repo = new LocalSupplyRepository(db as unknown as LocalDatabase)
})
afterEach(() => db.close())
it('searches all invoices before paginating; repeated lines do not duplicate an invoice', () => {
  for (const search of ['фІлЬтР', 'масляний wix', 'WA9428', '5449000351081']) {
    const first = repo.listInvoices({ tenant_id: 'shop', search, per_page: 20 })
    const second = repo.listInvoices({ tenant_id: 'shop', search, page: 2, per_page: 20 })
    expect(first.pagination.total).toBe(25)
    expect(first.data).toHaveLength(20); expect(second.data).toHaveLength(5)
    expect(new Set([...first.data, ...second.data].map(row => row.id)).size).toBe(25)
    expect(first.data[0].id).toBe('i-24')
  }
})
it('searches saved draft items and respects status, supplier and exclusions', () => {
  expect(repo.listInvoices({ tenant_id: 'shop', search: 'новий 999' }).data.map(row => row.id)).toEqual(['draft'])
  expect(repo.listInvoices({ tenant_id: 'shop', search: '999', status: 'posted' }).pagination.total).toBe(0)
  expect(repo.listInvoices({ tenant_id: 'shop', search: 'фільтр', supplier_id: 'missing' }).pagination.total).toBe(0)
  expect(repo.listInvoices({ tenant_id: 'shop', search: 'фільтр', exclude_ids: ['i-24'] }).pagination.total).toBe(24)
})
it('treats percent, underscore and SQL-like input as literal text', () => {
  expect(repo.listInvoices({ tenant_id: 'shop', search: '%_' }).data.map(row => row.id)).toEqual(['i-23'])
  expect(repo.listInvoices({ tenant_id: 'shop', search: "' OR 1=1 --" }).pagination.total).toBe(0)
})
it('finds a supplier by any substring, Unicode case or phone beyond the first page', () => {
  for (let i = 0; i < 220; i++) db.prepare("INSERT INTO suppliers VALUES(?,'shop',?,NULL,NULL,NULL,NULL,1,'now','now',NULL)").run('s'+i, 'AAA'+i)
  expect(repo.listSuppliers({ tenant_id: 'shop', per_page: 200 }).data.some(row => row.id === 's')).toBe(false)
  for (const search of ['комф', 'аВТОкОМФОРТ', '1234567']) expect(repo.listSuppliers({ tenant_id: 'shop', search }).data.map(row => row.id)).toEqual(['s'])
})
