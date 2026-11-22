import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { readProductCatalogSnapshot } from '../src/repositories/productCatalogSnapshot'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'

// Скарга власника 22.11.2026: «вбивали штрихкод 2005543129087, а програма його не знаходить».
// 17.11 проведення накладної замінило основний штрихкод 81 картки й стерло старий — наклеєні етикетки перестали скануватись.
let root: string, db: LocalDatabase, catalog: LocalCatalogRepository
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-barcode-kept-'))
  db = new LocalDatabase(root)
  catalog = new LocalCatalogRepository(db)
  catalog.saveProduct({ id: 'washer', sku: 'GCH-066', name: 'Омивач скла зимовий Гарячий шоколад 5л', barcode: '2005543129087', unit: 'шт', qty_on_hand: 10 })
})
afterEach(() => {
  db.close()
  if (path.dirname(path.resolve(root)) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-barcode-kept-')) rmSync(root, { recursive: true, force: true })
})

it('keeps the old main barcode working when a partial update sets a new one', () => {
  catalog.saveProduct({ id: 'washer', sku: 'GCH-066', name: 'Омивач скла зимовий Гарячий шоколад 5л', barcode: '2009320428684', unit: 'шт' })
  expect(catalog.findByBarcode('2009320428684')?.id).toBe('washer')
  // Стара етикетка й далі сканується.
  expect(catalog.findByBarcode('2005543129087')?.id).toBe('washer')
  expect(catalog.listProducts({ query: '2005543129087' }).data.map(product => product.id)).toEqual(['washer'])
  // Новий код — основний, старий — додатковий; на сервер їде обидва.
  expect(catalog.findById('washer')?.barcode).toBe('2009320428684')
  const snapshot = readProductCatalogSnapshot(db, 'washer', DEFAULT_TENANT_ID) as { barcode: string; additional_barcodes: string[] }
  expect(snapshot.barcode).toBe('2009320428684')
  expect(snapshot.additional_barcodes).toContain('2005543129087')
})

it('still removes a barcode when the card is saved with an explicit list of barcodes', () => {
  catalog.saveProduct({ id: 'washer', sku: 'GCH-066', name: 'Омивач скла зимовий Гарячий шоколад 5л', barcode: '2009320428684', unit: 'шт', additional_barcodes: [] })
  expect(catalog.findByBarcode('2005543129087')).toBeNull()
  expect(catalog.findByBarcode('2009320428684')?.id).toBe('washer')
})

it('a kept old barcode still cannot be given to another product', () => {
  catalog.saveProduct({ id: 'washer', sku: 'GCH-066', name: 'Омивач скла зимовий Гарячий шоколад 5л', barcode: '2009320428684', unit: 'шт' })
  expect(() => catalog.saveProduct({ id: 'other', sku: 'X-1', name: 'Інший товар', barcode: '2005543129087', unit: 'шт' })).toThrow('вже у товару')
})
