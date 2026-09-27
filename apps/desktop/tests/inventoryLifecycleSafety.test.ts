import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalInventoryRepository } from '../src/repositories/inventoryRepository'
import { isDesktopChannelAllowed } from '../src/security/desktopAuthorization'
let root: string, db: LocalDatabase, repo: LocalInventoryRepository, session: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-inventory-life-'))
  db = new LocalDatabase(root)
  new LocalCatalogRepository(db).upsertProduct({ id: 'p', sku: 'P', name: 'Фільтр', qty_on_hand: 12, purchase_price: 1000, retail_price: 1500,
    notes: 'keep', photo_url: 'photo', storage_bin: 'A1', specs: { size: 'M20' }, requires_core_return: true, core_deposit_amount: 250 })
  repo = new LocalInventoryRepository(db)
  session = repo.createSession({ name: 'Тест' }).id; repo.startSession(session)
  repo.countProduct(session, { product_id: 'p', qty: 3 })
})
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers(); db.close()
  if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-inventory-life-')) rmSync(root, { recursive: true, force: true })
})
const data = () => repo.getSessionData(session)
const row = () => data().items[0]
const product = () => db.prepare('SELECT * FROM products WHERE id = ?').get('p') as any
const edits = (value = 2000, base = 1500) => [{ product_id: 'p', values: { retail_price: value }, base: { retail_price: base } }]

it('does not delete a count accepted after the row was displayed', () => {
  const opened = row(); repo.scan(session, { product_id: 'p' })
  expect(() => repo.removeItem(session, opened.id, undefined, opened.edit_revision)).toThrow('DOCUMENT_CONFLICT')
  expect(row().counted_stock).toBe(4)
  const current = row(); repo.removeItem(session, current.id, undefined, current.edit_revision)
  expect(data().items).toHaveLength(0)
  expect(repo.removeItem(session, current.id, undefined, current.edit_revision)).toEqual({ ok: true })
  repo.scan(session, { product_id: 'p' })
  expect(() => repo.removeItem(session, current.id, undefined, current.edit_revision)).toThrow('DOCUMENT_CONFLICT')
  expect(row().counted_stock).toBe(1); expect(product().qty_on_hand).toBe(12)
})
it('rejects item IDs belonging to another session', () => {
  const other = repo.createSession({ name: 'Інша' }).id; repo.startSession(other)
  const opened = row()
  expect(() => repo.removeItem(other, opened.id, undefined, opened.edit_revision)).toThrow('не знайдено')
  expect(() => repo.setItemQty(other, opened.id, { counted_stock: 0, expected_revision: opened.edit_revision })).toThrow('не знайдено')
  expect(row().counted_stock).toBe(3)
})
it('requires reviewing the exact session before posting; replay never changes stock twice', () => {
  const opened = data(); repo.scan(session, { product_id: 'p' })
  expect(() => repo.complete(session, { expected_revision: opened.edit_revision })).toThrow('DOCUMENT_CONFLICT')
  expect(product().qty_on_hand).toBe(12)
  const current = data()
  expect(repo.complete(session, { expected_revision: current.edit_revision })).toEqual({ items_updated: 1 })
  expect(repo.complete(session, { expected_revision: current.edit_revision })).toEqual({ items_updated: 1 })
  expect(product().qty_on_hand).toBe(4)
  expect(db.prepare("SELECT COUNT(*) n FROM inventory_movements WHERE source_type='inventory'").get()).toEqual({ n: 1 })
})
it('detects removed/new rows and stock changes in a completion preview', () => {
  const opened = data(), item = row()
  repo.removeItem(session, item.id, undefined, item.edit_revision)
  expect(data().edit_revision).not.toBe(opened.edit_revision)
  repo.countProduct(session, { product_id: 'p', qty: 5 })
  expect(() => repo.complete(session, { expected_revision: opened.edit_revision })).toThrow('DOCUMENT_CONFLICT')
  const again = data(); db.prepare('UPDATE products SET qty_on_hand=13 WHERE id=?').run('p')
  expect(() => repo.complete(session, { expected_revision: again.edit_revision })).toThrow('DOCUMENT_CONFLICT')
  expect(product().qty_on_hand).toBe(13)
})
it('keeps the completion revision stable after reopening the database', () => {
  const revision = data().edit_revision
  db.close(); db = new LocalDatabase(root); repo = new LocalInventoryRepository(db)
  expect(data().edit_revision).toBe(revision)
})
it('reads a consistent snapshot without waiting for another connection holding the writer lock', () => {
  const other = new LocalDatabase(root), opened = data()
  try {
    other.exec('BEGIN IMMEDIATE')
    other.prepare('UPDATE products SET retail_price=2200 WHERE id=?').run('p')
    const start = performance.now()
    const duringWrite = data()
    expect(duringWrite.edit_revision).toBe(opened.edit_revision)
    expect(duringWrite.items[0].product.retail_price).toBe(1500)
    expect(performance.now() - start).toBeLessThan(1000)
    other.exec('ROLLBACK')
  } finally { other.close() }
})
it('keeps session and rows in one snapshot even when another connection commits between reads', () => {
  const other = new LocalDatabase(root), opened = data(), prepare = db.prepare.bind(db)
  let changed = false
  const hook = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    if (!changed && sql.includes('FROM inventory_items i')) {
      changed = true
      other.transaction(() => {
        other.prepare('UPDATE products SET retail_price=2200 WHERE id=?').run('p')
        other.prepare('UPDATE inventory_sessions SET session_name=? WHERE id=?').run('Інша назва', session)
      })
    }
    return prepare(sql)
  })
  try {
    const snapshot = data()
    expect(changed).toBe(true)
    expect(snapshot.edit_revision).toBe(opened.edit_revision)
    expect(snapshot.name).toBe(opened.name)
    expect(snapshot.items[0].product.retail_price).toBe(1500)
    hook.mockRestore()
    expect(data().name).toBe('Інша назва')
    expect(data().items[0].product.retail_price).toBe(2200)
  } finally { hook.mockRestore(); other.close() }
})
it('invalidates completion review after a product price changes', () => {
  const opened = data()
  repo.updateProducts(session, { edits: edits() })
  expect(() => repo.complete(session, { expected_revision: opened.edit_revision })).toThrow('DOCUMENT_CONFLICT')
  expect(product().qty_on_hand).toBe(12)
})
it('checks active status inside the same transaction as a legacy scan/count', () => {
  const transaction = db.transaction.bind(db)
  vi.spyOn(db, 'transaction').mockImplementationOnce(work => transaction(() => {
    db.prepare("UPDATE inventory_sessions SET status='completed' WHERE id=?").run(session)
    return work()
  }))
  expect(() => repo.scan(session, { product_id: 'p' })).toThrow('не активна')
  expect(row().counted_stock).toBe(3)
})
it('refuses an empty-session deletion if a count arrives before the transaction', () => {
  const empty = repo.createSession({ name: 'Порожня' }).id; repo.startSession(empty)
  const transaction = db.transaction.bind(db)
  vi.spyOn(db, 'transaction').mockImplementationOnce(work => transaction(() => {
    repo.countProduct(empty, { product_id: 'p', qty: 2 }); return work()
  }))
  expect(() => repo.deleteEmptySession(empty)).toThrow('тільки порожні')
  expect(repo.getSessionData(empty).status).toBe('in_progress')
})
it('preserves all unrelated product metadata, stock, barcodes and cross numbers', () => {
  const catalog = new LocalCatalogRepository(db)
  catalog.saveProduct({ ...product(), is_active: true, requires_core_return: true, specs: { size: 'M20' }, cross_numbers: ['W67/1'], additional_barcodes: ['0001234'] })
  const before = product()
  repo.updateProducts(session, { edits: edits() })
  const after = product()
  for (const field of ['qty_on_hand','photo_url','notes','storage_bin','specs_json','requires_core_return','core_deposit_amount']) expect(after[field]).toEqual(before[field])
  expect(after.retail_price).toBe(2000)
  expect(db.prepare('SELECT barcode FROM product_barcodes WHERE product_id=? AND deleted_at IS NULL').all('p')).toEqual([{ barcode: '0001234' }])
  expect(db.prepare('SELECT cross_number FROM product_cross_numbers WHERE product_id=? AND deleted_at IS NULL').all('p')).toEqual([{ cross_number: 'W67/1' }])
})
it('does not overwrite a newer field even in the same millisecond; identical retry is harmless', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-25T09:00:00Z'))
  repo.updateProducts(session, { edits: edits() })
  expect(() => repo.updateProducts(session, { edits: edits(1700) })).toThrow('DOCUMENT_CONFLICT')
  expect(() => repo.updateProducts(session, { edits: edits() })).not.toThrow()
  expect(product().retail_price).toBe(2000)
  db.prepare('UPDATE products SET purchase_price=1200 WHERE id=?').run('p')
  expect(() => repo.updateProducts(session, { edits: [{ product_id: 'p', values: { retail_price: 2400 }, base: { retail_price: 2000, purchase_price: 1000 } }] })).toThrow('DOCUMENT_CONFLICT')
})
it('rolls back the whole price batch if a later product conflicts', () => {
  new LocalCatalogRepository(db).upsertProduct({ id: 'q', sku: 'Q', name: 'Інший', retail_price: 3000 })
  const outbox = db.prepare('SELECT COUNT(*) n FROM sync_outbox').get()
  expect(() => repo.updateProducts(session, { edits: [...edits(), { product_id: 'q', values: { retail_price: 4000 }, base: { retail_price: 2500 } }] })).toThrow('DOCUMENT_CONFLICT')
  expect(product().retail_price).toBe(1500)
  expect(db.prepare('SELECT COUNT(*) n FROM sync_outbox').get()).toEqual(outbox)
})
it('updates the search index for an edited name and validates SKU uniqueness', () => {
  repo.updateProducts(session, { edits: [{ product_id: 'p', values: { name: 'Ремінь новий', sku: 'NEW' }, base: { name: 'Фільтр', sku: 'P' } }] })
  expect(product().name).toBe('Ремінь новий'); expect(product().sku).toBe('NEW')
  expect(new LocalCatalogRepository(db).searchProducts('ремінь новий').map(item => item.id)).toContain('p')
  expect(new LocalCatalogRepository(db).searchProducts('Фільтр').map(item => item.id)).not.toContain('p')
  new LocalCatalogRepository(db).upsertProduct({ id: 'q', sku: 'OTHER', name: 'Інший' })
  expect(() => repo.updateProducts(session, { edits: [{ product_id: 'p', values: { sku: 'OTHER' }, base: { sku: 'NEW' } }] })).toThrow()
  expect(product().sku).toBe('NEW')
})
it('rolls back product, search index and price-issue acknowledgement when the outbox fails', () => {
  repo.countProduct(session, { product_id: 'p', qty: 0, observed_retail_price: 1800 })
  const before = product(), outbox = db.prepare('SELECT COUNT(*) n FROM sync_outbox').get()
  const prepare = db.prepare.bind(db)
  const fault = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    if (sql.includes('INSERT INTO sync_outbox')) throw new Error('Synthetic outbox failure')
    return prepare(sql)
  })
  expect(() => repo.applyPrice(session, { product_id: 'p', retail_price: 1800, expected_price: 1500 })).toThrow('Synthetic outbox failure')
  fault.mockRestore()
  expect(product()).toEqual(before)
  expect(db.prepare('SELECT COUNT(*) n FROM sync_outbox').get()).toEqual(outbox)
  expect(data().price_issues).toHaveLength(1)
})
it.each([{ qty_on_hand: 99 }, { retail_price: -1 }, { retail_price: 1.2 }, { retail_price: NaN }, { name: '' }])('rejects invalid or stock edits %j', values => {
  expect(() => repo.updateProducts(session, { edits: [{ product_id: 'p', values, base: { retail_price: 1500, name: 'Фільтр' } } as any] })).toThrow()
  expect(product().qty_on_hand).toBe(12); expect(product().retail_price).toBe(1500)
})
it('rejects edits without a baseline, after completion and across tenants', () => {
  expect(() => repo.updateProducts(session, { edits: [{ product_id: 'p', values: { retail_price: 2500 }, base: {} }] })).toThrow('DOCUMENT_CONFLICT')
  expect(() => repo.updateProducts(session, { tenant_id: 'other', edits: edits() })).toThrow('не знайдено')
  repo.complete(session)
  expect(() => repo.updateProducts(session, { edits: edits() })).toThrow('не активна')
  expect(product().retail_price).toBe(1500)
})
it('price-issue acceptance rejects stale price and keeps the mismatch', () => {
  repo.countProduct(session, { product_id: 'p', qty: 0, observed_retail_price: 1800 })
  repo.updateProducts(session, { edits: edits() })
  expect(() => repo.applyPrice(session, { product_id: 'p', retail_price: 1800, expected_price: 1500 })).toThrow('DOCUMENT_CONFLICT')
  expect(data().price_issues).toHaveLength(1)
  repo.applyPrice(session, { product_id: 'p', retail_price: 1800, expected_price: 2000 })
  expect(data().price_issues).toHaveLength(0)
})
it('requires revisions at public delete/complete handlers and restricts product edits to receiving roles', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  for (const action of ['remove-item', 'complete']) expect(main.slice(main.indexOf(`handleDesktopIpc('desktop:inventory:${action}'`)).split('\n  )')[0]).toContain('requireDocumentRevision')
  expect(isDesktopChannelAllowed('desktop:inventory:update-products', 'cashier')).toBe(true)
  expect(isDesktopChannelAllowed('desktop:inventory:update-products', 'sto_viewer')).toBe(false)
})
