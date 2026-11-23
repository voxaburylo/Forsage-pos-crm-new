import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'

// 23.11.2026, слово власника: крос-номери — як у постачальників: «Hyundai: a, b; Kia: c; MANN: d».
// Для цього каса зберігає бренд номера (колонка brand у product_cross_numbers була, але не заповнювалась).
describe('cross numbers keep their brand on the till', () => {
  let root: string, db: LocalDatabase, catalog: LocalCatalogRepository
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-cross-brand-'))
    db = new LocalDatabase(root)
    catalog = new LocalCatalogRepository(db)
    catalog.saveProduct({ id: 'a', sku: 'W811/80', name: 'Filter W811/80', qty_on_hand: 5, retail_price: 12000, purchase_price: 8000 })
  })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  const view = () => catalog.listCrossNumbers('a').map(row => [row.number, row.brand])

  it('stores the brand with a number; a plain string still works', () => {
    catalog.changeCrossNumbers('a', { add: [{ number: '26300-35503', brand: 'Hyundai' }, { number: '26300-35530', brand: ' Kia ' }, 'OC195'] })
    expect(view()).toEqual([['26300-35503', 'Hyundai'], ['26300-35530', 'Kia'], ['OC195', null]])
  })

  it('adds a missing brand to a number that is already there and never erases one', () => {
    catalog.changeCrossNumbers('a', { add: ['OC195', { number: 'PH6607', brand: 'FRAM' }] })
    const before = catalog.listCrossNumbers('a').map(row => row.id)
    catalog.changeCrossNumbers('a', { add: [{ number: 'oc 195', brand: 'KNECHT' }, { number: 'PH-6607', brand: 'Other' }, 'PH6607'] })
    expect(view()).toEqual([['OC195', 'KNECHT'], ['PH6607', 'FRAM']])
    // Ті самі записи, нічого не створено заново.
    expect(catalog.listCrossNumbers('a').map(row => row.id)).toEqual(before)
  })

  it('refuses a malformed brand or number and changes nothing', () => {
    expect(() => catalog.changeCrossNumbers('a', { add: [{ number: 'OC195', brand: 'x'.repeat(101) }] })).toThrow('Перевірте крос-номери')
    expect(() => catalog.changeCrossNumbers('a', { add: [{ number: 12345 as unknown as string, brand: 'MANN' }] })).toThrow('Перевірте крос-номери')
    expect(() => catalog.changeCrossNumbers('a', { add: [{ number: 'OC195', brand: 7 as unknown as string }] })).toThrow('Перевірте крос-номери')
    expect(view()).toEqual([])
  })

  it('the cloud copy still receives plain numbers', () => {
    catalog.changeCrossNumbers('a', { add: [{ number: '26300-35503', brand: 'Hyundai' }] })
    const row = db.prepare("SELECT payload_json FROM sync_outbox WHERE operation_type = 'product.upsert' ORDER BY rowid DESC LIMIT 1").get() as { payload_json: string }
    expect(JSON.parse(row.payload_json).cross_numbers).toEqual(['26300-35503'])
  })
})
