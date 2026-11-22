import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { pendingErasedBarcodes, restoreErasedBarcodes } from '../src/repositories/restoreErasedBarcodes'

// Рішення власника 22.11.2026 «Вернуть»: 116 штрихкодів, стертих до виправлення, повертаються карткам як додаткові.
let root: string, db: LocalDatabase, catalog: LocalCatalogRepository
const eraseBefore = (barcode: string, when: string) => db.prepare('UPDATE product_barcodes SET deleted_at = ? WHERE barcode = ?').run(when, barcode)

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-barcode-restore-'))
  db = new LocalDatabase(root)
  catalog = new LocalCatalogRepository(db)
  catalog.saveProduct({ id: 'washer', sku: 'GCH-066', name: 'Омивач скла', barcode: '2009320428684', unit: 'шт', additional_barcodes: ['2005543129087', '2000000000017'] })
  catalog.saveProduct({ id: 'other', sku: 'X-1', name: 'Інший товар', barcode: '4820000000001', unit: 'шт' })
})
afterEach(() => {
  db.close()
  if (path.dirname(path.resolve(root)) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-barcode-restore-')) rmSync(root, { recursive: true, force: true })
})

it('returns a code erased before the fix as an additional barcode and keeps the others', () => {
  eraseBefore('2005543129087', '2026-11-17T08:35:00.000Z')
  expect(catalog.findByBarcode('2005543129087')).toBeNull()
  expect(pendingErasedBarcodes(db)).toBe(1)
  expect(restoreErasedBarcodes(db)).toEqual({ restored: 1, skipped: 0 })
  expect(catalog.findByBarcode('2005543129087')?.id).toBe('washer')
  expect(catalog.findByBarcode('2000000000017')?.id).toBe('washer')
  expect(catalog.findById('washer')?.barcode).toBe('2009320428684')
  expect(pendingErasedBarcodes(db)).toBe(0)
  expect(restoreErasedBarcodes(db)).toEqual({ restored: 0, skipped: 0 })
  expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'catalog.barcode_restore'").get()).toMatchObject({ n: 1 })
})

it('leaves codes erased after the owner approved the list and codes now used by another card', () => {
  eraseBefore('2005543129087', '2026-11-22T12:00:00.000Z')
  eraseBefore('2000000000017', '2026-11-17T08:35:00.000Z')
  catalog.saveProduct({ id: 'other', sku: 'X-1', name: 'Інший товар', barcode: '4820000000001', unit: 'шт', additional_barcodes: ['2000000000017'] })
  expect(pendingErasedBarcodes(db)).toBe(0)
  expect(restoreErasedBarcodes(db)).toEqual({ restored: 0, skipped: 0 })
  expect(catalog.findByBarcode('2005543129087')).toBeNull()
  expect(catalog.findByBarcode('2000000000017')?.id).toBe('other')
})
