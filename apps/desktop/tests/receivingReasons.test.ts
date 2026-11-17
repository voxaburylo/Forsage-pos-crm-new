import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import { commitReceiving, findInvoiceIdentifierConflict, type ReceivingCommitInput, type ReceivingLine } from '../src/repositories/receivingCommit'
import { safeProblemDetail } from '../src/diagnostics/problemDetails'
import { receivingLineReason } from '../src/diagnostics/receivingReasons'

const line = (overrides: Partial<ReceivingLine> = {}): ReceivingLine => ({ client_key: randomUUID(), product_name: 'Щітка склоочисника 400', sku: 'WB-400',
  qty: 5, purchase_price: 1000, retail_price: 1500, category_id: null, ...overrides })

describe('identifier conflicts inside one invoice', () => {
  it('flags the same barcode on two different goods and names both rows', () => {
    const conflict = findInvoiceIdentifierConflict([
      line({ barcode: '6939824294323' }),
      line({ sku: 'WB-450', product_name: 'Щітка склоочисника 450', barcode: '6939-8242-94323' }),
    ])
    expect(conflict).toEqual({ index: 1, other: 0, field: 'barcode', value: '6939-8242-94323' })
  })
  it('flags the same SKU on two different selected cards', () => {
    expect(findInvoiceIdentifierConflict([line({ product_id: 'a' }), line({ product_id: 'b', product_name: 'Інша' , sku: 'wb-400' })]))
      .toMatchObject({ index: 1, other: 0, field: 'sku' })
  })
  it('allows the same goods repeated on two rows', () => {
    expect(findInvoiceIdentifierConflict([line({ barcode: '111' }), line({ barcode: '111', product_name: ' щітка  склоочисника 400 ' })])).toBeNull()
    expect(findInvoiceIdentifierConflict([line({ product_id: 'a', barcode: '111' }), line({ product_id: 'a', barcode: '111', product_name: 'інша назва' })])).toBeNull()
    expect(findInvoiceIdentifierConflict([line({ sku: '', barcode: '' }), line({ sku: '', barcode: '', product_name: 'Інша' })])).toBeNull()
  })
})

describe('receiving failures carry a reason code without goods data', () => {
  let root: string, db: LocalDatabase, catalog: LocalCatalogRepository, supplier: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-receiving-reasons-'))
    db = new LocalDatabase(root); catalog = new LocalCatalogRepository(db)
    supplier = new LocalSupplyRepository(db).saveSupplier({ name: 'Тестовий постачальник' }).id
  })
  afterEach(() => { db.close(); if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-receiving-reasons-')) rmSync(root, { recursive: true, force: true }) })
  const body = (items: ReceivingLine[]): ReceivingCommitInput => ({ invoice_id: randomUUID(), operation_id: randomUUID(), supplier_id: supplier, items, payments: [] })
  const counts = () => db.prepare('SELECT (SELECT count(*) FROM products) p, (SELECT count(*) FROM supply_invoices) i').get()

  it('refuses a duplicate barcode between different goods before any write', () => {
    const before = counts()
    let message = ''
    try { commitReceiving(db, body([line({ barcode: '6939824294323' }), line({ sku: 'WB-450', product_name: 'Щітка 450', barcode: '6939824294323' })])) }
    catch (error) { message = (error as Error).message }
    expect(message).toMatch(/^RECEIVING_LINE:1:duplicate-in-invoice: Рядок 2: Штрихкод «6939824294323» вже є в рядку 1/)
    expect(counts()).toEqual(before)
    const detail = safeProblemDetail(message, 'ipc.desktop:supply:commit-receiving')!
    expect(detail).toBe('Проведення накладної, рядок 2: Той самий штрихкод або артикул стоїть у двох різних товарах цієї накладної [receiving-duplicate-in-invoice].')
    expect(detail).not.toContain('6939824294323')
    // Журнал перечитує збережений опис — він не має перетворитися на «невідому помилку».
    expect(safeProblemDetail(detail, 'ipc.desktop:supply:commit-receiving')).toBe(detail)
  })
  it('names a database conflict with a code', () => {
    catalog.saveProduct({ id: randomUUID(), sku: 'OTHER', name: 'Інший товар', barcode: '555', qty_on_hand: 0 })
    const own = catalog.saveProduct({ id: randomUUID(), sku: 'WB-400', name: 'Щітка склоочисника 400', qty_on_hand: 0 })
    const item = line({ product_id: own.id, barcode: '555', product_base: { name: own.name, sku: own.sku, barcode: null, retail_price: 1500, storage_bin: null, category_id: null, photo_url: null } })
    expect(() => commitReceiving(db, body([item]))).toThrow(/^RECEIVING_LINE:0:identifier-several-cards: /)
  })
  it('names the failed step and keeps only a fingerprint of the inner error', () => {
    const detail = safeProblemDetail('RECEIVING_STEP:posting: SQLITE_BUSY: database is locked «Щітка WB-400»', 'ipc.desktop:supply:commit-receiving')!
    expect(detail).toMatch(/^Проведення накладної: збій на кроці «проведення залишків»; .+ \[receiving-step-posting:[a-z-]+\]\. Відбиток: [a-f0-9]{20}\.$/)
    expect(detail).not.toContain('WB-400')
    expect(safeProblemDetail(detail, 'ipc.desktop:supply:commit-receiving')).toBe(detail)
  })
  it('falls back to a generic validation code for unknown row texts', () => {
    expect(receivingLineReason('Кількість має бути більшою за нуль')).toBe('line-validation')
  })
})
