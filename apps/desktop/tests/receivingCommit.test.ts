import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'
import { commitReceiving, type ReceivingCommitInput, type ReceivingLine } from '../src/repositories/receivingCommit'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'

describe('atomic receiving on isolated SQLite', () => {
  let root: string, db: LocalDatabase, catalog: LocalCatalogRepository, supply: LocalSupplyRepository, supplier: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-receiving-atomic-'))
    db = new LocalDatabase(root); catalog = new LocalCatalogRepository(db); supply = new LocalSupplyRepository(db)
    supplier = supply.saveSupplier({ name: 'Тестовий постачальник' }).id
  })
  afterEach(() => { db.close(); if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-receiving-atomic-')) rmSync(root, { recursive: true, force: true }) })
  const line = (overrides: Partial<ReceivingLine> = {}): ReceivingLine => ({ client_key: randomUUID(), product_name: 'Круг тестовий', sku: 'CIRCLE', qty: 98, purchase_price: 1000, retail_price: 1500, category_id: null, ...overrides })
  function body(items = [line()]): ReceivingCommitInput { return { invoice_id: randomUUID(), operation_id: randomUUID(), supplier_id: supplier, items, payments: [] } }
  function snapshot() {
    return Object.fromEntries(['products', 'product_barcodes', 'supply_invoices', 'supply_invoice_items', 'supplier_payments', 'cash_operations', 'inventory_movements', 'sync_outbox', 'app_meta']
      .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
  }
  function linked() {
    const product = catalog.saveProduct({ id: randomUUID(), sku: 'CIRCLE', name: 'Круг тестовий', purchase_price: 900, retail_price: 1500, qty_on_hand: 3,
      notes: 'Не стерти', specs: { size: '100мм' }, is_favorite: true })
    return line({ product_id: product.id, product_base: { name: product.name, sku: product.sku, barcode: null, retail_price: 1500, storage_bin: null, category_id: null, photo_url: null } })
  }
  it('creates products, posts 98 and split payments once, including after restart', () => {
    const pos = new LocalPosRepository(db), cashier = randomUUID()
    const shift = pos.openShift({ cashier_id: cashier, opening_cash: 60000 })
    const input = body(); input.payments = [
      { amount: 50000, payment_method: 'cash', fund_source: 'cashbox', shift_id: shift },
      { amount: 48000, payment_method: 'cash', fund_source: 'owner_funds' },
    ]
    const saved = commitReceiving(db, input)
    expect(saved.status).toBe('posted'); expect(saved.total).toBe(98000); expect(saved.paid_amount).toBe(98000)
    expect(catalog.findById(saved.items[0].product_id)?.qty_on_hand).toBe(98)
    expect(pos.getExpectedCash(cashier)?.expected_amount).toBe(10000)
    const before = snapshot(); db.close(); db = new LocalDatabase(root)
    expect(commitReceiving(db, input).id).toBe(saved.id); expect(snapshot()).toEqual(before)
  })
  it('changed retry after lost reply cannot create a second document or payment', () => {
    const input = body(); commitReceiving(db, input); const before = snapshot()
    expect(() => commitReceiving(db, { ...input, items: [line({ qty: 99 })] })).toThrow('Повтор операції')
    expect(() => commitReceiving(db, { ...input, operation_id: randomUUID(), items: [line({ qty: 99 })] })).toThrow('DOCUMENT_CONFLICT')
    expect(snapshot()).toEqual(before)
  })
  it('rolls back earlier product writes and first payment if the second payment fails', () => {
    const first = linked(); const input = body([{ ...first, retail_price: 2500 }, line({ sku: 'NEW', product_name: 'Новий товар' })])
    input.payments = [{ amount: 100, payment_method: 'cash', fund_source: 'owner_funds' }, { amount: 100, payment_method: 'cash', fund_source: 'cashbox' }]
    const before = snapshot(); expect(() => commitReceiving(db, input)).toThrow(/змін|кас/i); expect(snapshot()).toEqual(before)
  })
  it('rolls back every record when the final posted outbox fails', () => {
    const input = body([linked(), line({ sku: 'NEW', product_name: 'Новий товар' })])
    input.payments = [{ amount: 100, payment_method: 'cash', fund_source: 'owner_funds' }]
    db.exec("CREATE TRIGGER fail_final BEFORE INSERT ON sync_outbox WHEN NEW.operation_type = 'supplier_invoice.posted' BEGIN SELECT RAISE(ABORT, 'test final failure'); END")
    const before = snapshot(); expect(() => commitReceiving(db, input)).toThrow('test final failure'); expect(snapshot()).toEqual(before)
  })
  it('rolls back even after posting if the durable operation receipt cannot be stored', () => {
    const input = body(); input.payments = [{ amount: 100, payment_method: 'cash', fund_source: 'owner_funds' }]
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'mutation:receiving:%' BEGIN SELECT RAISE(ABORT, 'receipt failure'); END")
    const before = snapshot(); expect(() => commitReceiving(db, input)).toThrow('receipt failure'); expect(snapshot()).toEqual(before)
  })
  it('rolls back an existing draft including card edits on failure; then saves last quantity', () => {
    const row = linked(); const draft = supply.createInvoice({ supplier_id: supplier, items: [{ product_id: row.product_id!, qty: 46, purchase_price: 1000 }] })
    const input = { ...body([{ ...row, retail_price: 2000 }]), invoice_id: draft.id, expected_revision: draft.edit_revision }
    input.payments = [{ amount: 999999, payment_method: 'cash', fund_source: 'owner_funds' }]
    const before = snapshot(); expect(() => commitReceiving(db, input)).toThrow(/борг/); expect(snapshot()).toEqual(before)
    input.payments = []; const saved = commitReceiving(db, input)
    expect(saved.items[0].qty).toBe(98); expect(catalog.findById(row.product_id!)?.qty_on_hand).toBe(101)
    const stored = db.prepare('SELECT notes, specs_json, is_favorite FROM products WHERE id = ?').get(row.product_id!)
    expect(stored).toEqual({ notes: 'Не стерти', specs_json: '{"size":"100мм"}', is_favorite: 1 })
  })
  it('stale invoice prevents any product writes', () => {
    const row = linked(); const draft = supply.createInvoice({ supplier_id: supplier, items: [{ product_id: row.product_id!, qty: 46, purchase_price: 1000 }] })
    supply.updateInvoice(draft.id, { notes: 'Нові умови' })
    const before = snapshot(); expect(() => commitReceiving(db, { ...body([row]), invoice_id: draft.id, expected_revision: draft.edit_revision })).toThrow('DOCUMENT_CONFLICT'); expect(snapshot()).toEqual(before)
  })
  it('preserves a concurrent sale and unrelated card change while applying only edited fields', () => {
    const row = linked(); db.prepare('UPDATE products SET qty_on_hand = 2, storage_bin = ? WHERE id = ?').run('А-1', row.product_id!)
    commitReceiving(db, body([{ ...row, retail_price: 2000 }]))
    const saved = catalog.findById(row.product_id!)!; expect(saved.qty_on_hand).toBe(100); expect(saved.storage_bin).toBe('А-1'); expect(saved.retail_price).toBe(2000)
  })
  it('rejects two editors changing the same price and identifies the row', () => {
    const row = linked(); db.prepare('UPDATE products SET retail_price = 1800 WHERE id = ?').run(row.product_id!)
    const before = snapshot(); expect(() => commitReceiving(db, body([{ ...row, retail_price: 2000 }]))).toThrow('RECEIVING_LINE:0:'); expect(snapshot()).toEqual(before)
  })
  it('matches existing exact SKU/barcode without replacing identity and rejects contradictory codes', () => {
    const row = linked(); catalog.saveProduct({ id: randomUUID(), sku: 'OTHER', name: 'Інший', barcode: '00123', qty_on_hand: 0 })
    const before = snapshot(); expect(() => commitReceiving(db, body([line({ barcode: '00123' })]))).toThrow('RECEIVING_LINE:0:'); expect(snapshot()).toEqual(before)
    const saved = commitReceiving(db, body([line({ product_name: 'Назва постачальника' })]))
    expect(saved.items[0].product_id).toBe(row.product_id); expect(catalog.findById(row.product_id!)?.name).toBe('Круг тестовий')
  })
  it('does not merge similar names or use a deleted card as an implicit replacement', () => {
    const row = linked(); const saved = commitReceiving(db, body([line({ sku: 'CIRCLE2', product_name: 'Круг тестовий 2' })]))
    expect(saved.items[0].product_id).not.toBe(row.product_id)
    catalog.deleteProduct(row.product_id!); const before = snapshot()
    expect(() => commitReceiving(db, body([row]))).toThrow('Вибраний товар видалено'); expect(snapshot()).toEqual(before)
  })
  it('repeated new lines use one card and sum stock without duplicate cards', () => {
    const saved = commitReceiving(db, body([line({ qty: 2 }), line({ qty: 3 })]))
    expect(saved.items[0].product_id).toBe(saved.items[1].product_id); expect(catalog.findById(saved.items[0].product_id)?.qty_on_hand).toBe(5)
  })
  it('requires explicit review for metadata changes from legacy drafts', () => {
    const row = linked(); delete row.product_base; const before = snapshot()
    expect(() => commitReceiving(db, body([{ ...row, retail_price: 2000 }]))).toThrow('Стара чернетка'); expect(snapshot()).toEqual(before)
    expect(commitReceiving(db, body([row])).status).toBe('posted')
  })
  it.each([NaN, -1, 0, Infinity])('rejects invalid quantity %s without writes', qty => {
    const before = snapshot(); expect(() => commitReceiving(db, body([line({ qty })]))).toThrow(); expect(snapshot()).toEqual(before)
  })
  it('rejects archived Cyrillic SKU aliases instead of resurrecting the deleted card', () => {
    const product = catalog.saveProduct({ id: randomUUID(), name: 'Архів', sku: 'КРУГ', qty_on_hand: 0 })
    catalog.deleteProduct(product.id); const before = snapshot()
    expect(() => commitReceiving(db, body([line({ sku: 'круг', product_name: 'Інший круг' })]))).toThrow('архівною')
    expect(snapshot()).toEqual(before)
  })
  it('rejects missing category before creating any cards', () => {
    const before = snapshot(); expect(() => commitReceiving(db, body([line({ category_id: randomUUID() })]))).toThrow('Категорію видалено'); expect(snapshot()).toEqual(before)
  })
  it('uses genuine additional barcodes and preserves leading zeroes', () => {
    const product = catalog.saveProduct({ id: randomUUID(), sku: 'EXTRA', name: 'Товар з додатковим кодом', additional_barcodes: ['000123'], qty_on_hand: 1 })
    const saved = commitReceiving(db, body([line({ sku: '', barcode: '000123', product_name: 'Імпортований' })]))
    expect(saved.items[0].product_id).toBe(product.id); expect(catalog.findById(product.id)?.qty_on_hand).toBe(99)
  })
  it('does not choose the first of ambiguous identical names', () => {
    catalog.saveProduct({ id: randomUUID(), sku: 'A', name: 'Однакові', qty_on_hand: 0 })
    catalog.saveProduct({ id: randomUUID(), sku: 'B', name: 'Однакові', qty_on_hand: 0 })
    const before = snapshot(); expect(() => commitReceiving(db, body([line({ sku: 'C', product_name: 'Однакові' })]))).toThrow('кілька товарів'); expect(snapshot()).toEqual(before)
  })
  it('keeps cashier receiving access without exposing the operation to read-only staff', () => {
    expect(isDesktopChannelAllowed('desktop:supply:commit-receiving', 'cashier')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:supply:commit-receiving', 'manager')).toBe(true)
    expect(isDesktopChannelAllowed('desktop:supply:commit-receiving', 'sto_viewer')).toBe(false)
    expect(isDesktopChannelAllowed('desktop:supply:commit-receiving', 'tire_worker')).toBe(false)
  })
})
