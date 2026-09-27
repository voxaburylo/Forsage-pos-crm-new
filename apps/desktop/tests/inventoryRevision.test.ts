import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalInventoryRepository } from '../src/repositories/inventoryRepository'
let root: string, db: LocalDatabase, repo: LocalInventoryRepository, session: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-inventory-revision-'))
  db = new LocalDatabase(root)
  new LocalCatalogRepository(db).upsertProduct({ id: 'p', sku: 'P', name: 'Товар', qty_on_hand: 12 })
  repo = new LocalInventoryRepository(db)
  session = repo.createSession({ name: 'Тест ревізії' }).id
  repo.startSession(session)
  repo.countProduct(session, { product_id: 'p', qty: 3 })
})
afterEach(() => {
  vi.useRealTimers(); db.close()
  if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-inventory-revision-')) rmSync(root, { recursive: true, force: true })
})
const item = () => repo.getSessionData(session).items[0]
it('does not overwrite a more recent manual count', () => {
  const before = item()
  const saved = repo.setItemQty(session, before.id, { counted_stock: 8, expected_revision: before.edit_revision })
  expect(saved.edit_revision).not.toBe(before.edit_revision)
  expect(saved.edit_revision).toBe(item().edit_revision)
  expect(() => repo.setItemQty(session, before.id, { counted_stock: 5, expected_revision: before.edit_revision })).toThrow('DOCUMENT_CONFLICT')
  expect(item().counted_stock).toBe(8)
  expect(db.prepare('SELECT qty_on_hand FROM products WHERE id = ?').get('p')).toEqual({ qty_on_hand: 12 })
  repo.complete(session)
  expect(db.prepare('SELECT qty_on_hand FROM products WHERE id = ?').get('p')).toEqual({ qty_on_hand: 8 })
})
it('does not erase a scan accepted while the manual field was open', () => {
  const before = item()
  repo.scan(session, { product_id: 'p', qty: 1 })
  expect(() => repo.setItemQty(session, before.id, { counted_stock: 3, expected_revision: before.edit_revision })).toThrow('DOCUMENT_CONFLICT')
  expect(item().counted_stock).toBe(4)
})
it('keeps the revision after database restart', () => {
  const before = item()
  db.close(); db = new LocalDatabase(root); repo = new LocalInventoryRepository(db)
  expect(item().edit_revision).toBe(before.edit_revision)
  expect(repo.setItemQty(session, before.id, { counted_stock: 0, expected_revision: before.edit_revision }).counted_stock).toBe(0)
})
it('detects two changes in the same millisecond', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-23T12:00:00Z'))
  const first = repo.setItemQty(session, item().id, { counted_stock: 8 })
  const second = repo.setItemQty(session, first.id, { counted_stock: 9, expected_revision: first.edit_revision })
  expect(second.updated_at).toBe(first.updated_at)
  expect(second.edit_revision).not.toBe(first.edit_revision)
})
