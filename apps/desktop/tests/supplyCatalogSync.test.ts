import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant, type LocalSyncOutboxOperation, type LocalSyncPushResult } from '../src/db/localTypes'
import { LOCAL_MIGRATIONS } from '../src/db/schema'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import { LocalSyncRepository } from '../src/repositories/syncRepository'

// The server source has no runtime imports. Execute the real batch contract
// without pulling server files into the desktop TypeScript root/package.
const serverBatch = {} as { processSyncBatch: (operations: LocalSyncOutboxOperation[],
  apply: (operation: LocalSyncOutboxOperation) => Promise<void>) => Promise<LocalSyncPushResult[]> }
runInNewContext(ts.transpileModule(readFileSync(new URL('../../../server/src/services/syncBatch.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: serverBatch })
const { processSyncBatch } = serverBatch

describe('supply purchase-price catalog copy', () => {
  let sqlite: DatabaseSync, db: LocalDatabase, catalog: LocalCatalogRepository, supply: LocalSupplyRepository
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T12:00:00Z'))
    sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON')
    for (const migration of LOCAL_MIGRATIONS) sqlite.exec(migration.sql)
    const transaction = <T>(work: () => T): T => {
      if (sqlite.isTransaction) return work()
      sqlite.exec('BEGIN IMMEDIATE')
      try { const value = work(); sqlite.exec('COMMIT'); return value }
      catch (error) { sqlite.exec('ROLLBACK'); throw error }
    }
    db = { deviceId: 'isolated-supply-catalog', prepare: (sql: string) => sqlite.prepare(sql), transaction, readSnapshot: transaction } as unknown as LocalDatabase
    catalog = new LocalCatalogRepository(db); supply = new LocalSupplyRepository(db)
    catalog.saveProduct({ id: 'product', sku: 'PRICE-ORIGINAL', name: 'Synthetic product', qty_on_hand: 3,
      purchase_price: 5000, retail_price: 10000, barcode: '1234567890123', additional_barcodes: ['6543210987654'],
      cross_numbers: ['CROSS-123'], specs: { grade: 'test' }, notes: 'keep notes', is_favorite: true })
  })
  afterEach(() => { sqlite.close(); vi.useRealTimers() })
  const product = () => sqlite.prepare('SELECT * FROM products WHERE id=?').get('product') as any
  const queue = () => sqlite.prepare('SELECT * FROM sync_outbox ORDER BY sequence').all() as any[]
  const cards = () => queue().filter(row => row.operation_type === 'product.upsert' && row.status !== 'synced')
  const latest = () => JSON.parse(cards().at(-1)?.payload_json ?? '{}')
  const state = () => Object.fromEntries(['products', 'product_barcodes', 'product_cross_numbers', 'supply_invoices',
    'supply_invoice_items', 'inventory_movements', 'sync_outbox', 'app_meta', 'sqlite_sequence']
    .map(table => [table, sqlite.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]))
  const draft = () => supply.createInvoice({ id: 'invoice', items: [
    { id: 'line1', product_id: 'product', qty: 1, purchase_price: 7000 },
    { id: 'line2', product_id: 'product', qty: 2, purchase_price: 8000 },
  ] })
  function post() { const invoice = draft(); return supply.postInvoice(invoice.id, { user_id: 'owner', expected_revision: invoice.edit_revision }) }

  it('queues the final current purchase price once per product, without replaying stock or changing the draft', () => {
    const invoice = draft(), beforeDraft = cards().length
    expect(product().purchase_price).toBe(5000)
    vi.setSystemTime(new Date('2026-10-12T12:01:00Z'))
    supply.postInvoice(invoice.id, { user_id: 'owner', expected_revision: invoice.edit_revision })
    expect(product()).toMatchObject({ purchase_price: 8000, qty_on_hand: 6, retail_price: 10000 })
    expect(cards().filter(row => JSON.parse(row.payload_json).purchase_price === 8000)).toHaveLength(1)
    expect(latest()).toMatchObject({ id: 'product', sku: 'PRICE-ORIGINAL', purchase_price: 8000, qty_on_hand: 6,
      retail_price: 10000, additional_barcodes: ['6543210987654'], cross_numbers: ['CROSS-123'], specs: { grade: 'test' },
      notes: 'keep notes', is_favorite: true, is_active: true, is_service: false })
    expect(latest().stock_correction).not.toBe(true)
    expect(beforeDraft).toBe(1)
    expect(sqlite.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE source_type='supply_invoice'").get()?.n).toBe(2)
    const done = state(); expect(() => supply.postInvoice(invoice.id)).toThrow(); expect(state()).toEqual(done)
  })
  it('keeps the latest purchase price when a later partial card edit retires the previous card copy', () => {
    post(); vi.setSystemTime(new Date('2026-10-12T12:02:00Z'))
    catalog.saveProduct({ id: 'product', sku: 'PRICE-NEW', name: 'Renamed', retail_price: 12000 })
    new LocalSyncRepository(db)
    expect(latest()).toMatchObject({ purchase_price: 8000, retail_price: 12000, sku: 'PRICE-NEW', name: 'Renamed',
      additional_barcodes: ['6543210987654'], cross_numbers: ['CROSS-123'], notes: 'keep notes', specs: { grade: 'test' } })
    expect(product().qty_on_hand).toBe(6)
  })
  it('delivers the catalog prerequisite after an offline invoice fails, then retries the invoice without replaying local stock', async () => {
    post()
    const sync = new LocalSyncRepository(db)
    const business = product(), movements = sqlite.prepare('SELECT * FROM inventory_movements ORDER BY rowid').all()
    let remoteCard: any = null, remoteInvoice = false, remotePosted = false
    const apply = async (operation: ReturnType<typeof sync.listPending>[number]) => {
      if (operation.operation_type === 'product.upsert') remoteCard = operation.payload
      if (operation.operation_type === 'supplier_invoice.created') {
        if (!remoteCard) throw new Error('Missing product copy')
        remoteInvoice = true
      }
      if (operation.operation_type === 'supplier_invoice.posted') {
        if (!remoteInvoice) throw new Error('Missing invoice copy')
        remotePosted = true
      }
    }
    // Use the real server batch barriers, not a mock that accepts everything.
    sync.applyPushResults(await processSyncBatch(sync.listPending(100), apply))
    expect(queue().some(row => row.operation_type === 'supplier_invoice.created' && row.status === 'failed')).toBe(true)
    const prerequisite = sync.listPending(1)
    expect(prerequisite.map(row => row.operation_type)).toEqual(['product.upsert'])
    expect(prerequisite[0].payload).toMatchObject({ purchase_price: 8000, qty_on_hand: 6 })
    sync.applyPushResults(await processSyncBatch(prerequisite, apply))
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'))
    sync.applyPushResults(await processSyncBatch(sync.listPending(100), apply))
    sync.applyPushResults(await processSyncBatch(sync.listPending(100), apply))
    expect(remotePosted).toBe(true)
    expect(remoteCard).toMatchObject({ purchase_price: 8000, retail_price: 10000 })
    expect(queue().filter(row => row.status !== 'synced')).toHaveLength(0)
    expect(product()).toEqual({ ...business, dirty_at: null })
    expect(sqlite.prepare('SELECT * FROM inventory_movements ORDER BY rowid').all()).toEqual(movements.map(row =>
      row.source_type === 'supply_invoice' ? { ...row, dirty_at: null } : row))
  })
  it.each(['abort', 'skip', 'alter'])('rolls back the whole posting if its catalog copy is %s', kind => {
    const invoice = draft(), before = state()
    sqlite.exec(`CREATE TRIGGER bad_catalog ${kind === 'alter' ? 'AFTER' : 'BEFORE'} INSERT ON sync_outbox
      WHEN NEW.operation_type='product.upsert'
      BEGIN ${kind === 'abort' ? "SELECT RAISE(ABORT,'catalog failure')" : kind === 'skip' ? 'SELECT RAISE(IGNORE)' : "UPDATE sync_outbox SET payload_json='{}' WHERE operation_id=NEW.operation_id"}; END`)
    expect(() => supply.postInvoice(invoice.id, { user_id: 'owner', expected_revision: invoice.edit_revision })).toThrow()
    expect(state()).toEqual(before)
  })
  it('retains the posted purchase cost when a later cancellation changes only stock', () => {
    post(); const postedPrice = latest().purchase_price
    supply.cancelInvoice('invoice', tenant)
    expect(product()).toMatchObject({ qty_on_hand: 3, purchase_price: 8000 })
    expect(postedPrice).toBe(8000)
  })
  it('preserves omitted values but honors explicit null, zero, false and empty lists', () => {
    catalog.saveProduct({ id: 'product', sku: 'PRICE-ORIGINAL', name: 'Still named', purchase_price: undefined })
    expect(latest()).toMatchObject({ purchase_price: 5000, notes: 'keep notes', is_favorite: true, barcode: '1234567890123' })
    catalog.saveProduct({ id: 'product', sku: 'PRICE-ORIGINAL', name: 'Explicit changes', purchase_price: 0,
      notes: null, barcode: null, is_favorite: false, additional_barcodes: [], cross_numbers: [], specs: {} })
    expect(latest()).toMatchObject({ purchase_price: 0, notes: null, barcode: null, is_favorite: false,
      additional_barcodes: [], cross_numbers: [], specs: {} })
    expect(product().qty_on_hand).toBe(3)
  })
})
