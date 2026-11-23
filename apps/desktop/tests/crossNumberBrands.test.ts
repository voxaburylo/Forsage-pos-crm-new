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

// 23.11.2026: до паливного фільтра (крос Hengst «E87KP D150») «прив'язались» полірувальні круги «… M14 d150»:
// крос-номер ділився на шматки, і «D150» збігся з діаметром у назві.
describe('a cross number is one number even with a space', () => {
  it('is looked up whole; only a record with a brand word is split', async () => {
    const { crossNumberCodes } = await import('../src/repositories/catalogRepository')
    expect(crossNumberCodes('E87KP D150')).toEqual(['E87KPD150'])
    expect(crossNumberCodes('PE 973/2')).toEqual(['PE9732'])
    expect(crossNumberCodes('W 811/80')).toEqual(['W81180'])
    expect(crossNumberCodes('MANN W811/80')).toEqual(expect.arrayContaining(['MANNW81180', 'W81180']))
    expect(crossNumberCodes('V10-0499')).toEqual(['V100499'])
    // Старі записи «бренд: номер» теж розпізнаються.
    expect(crossNumberCodes('WIX: WL7131')).toContain('WL7131')
    expect(crossNumberCodes('MAHLE OC 196')).toContain('OC196')
    expect(crossNumberCodes('A1')).toEqual([])
  })

  it('polishing pads with «d150» in the name are not analogs of the filter', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'forsage-cross-d150-'))
    const db = new LocalDatabase(root)
    try {
      const catalog = new LocalCatalogRepository(db)
      catalog.saveProduct({ id: 'filter', sku: '77811', name: 'Фильтр топливный MAHLE KX 228 D VW CADDY', qty_on_hand: 1, retail_price: 66500, purchase_price: 40000 })
      catalog.saveProduct({ id: 'pad', sku: '85506', name: 'Губка полировочная APP GP 150 M M14 d150 желтая', qty_on_hand: 0, retail_price: 31000, purchase_price: 20000 })
      catalog.saveProduct({ id: 'analog', sku: 'WF8355', name: 'Фільтр паливний WIX WF8355', qty_on_hand: 2, retail_price: 50000, purchase_price: 30000 })
      catalog.changeCrossNumbers('filter', { add: [{ number: 'E87KP D150', brand: 'Hengst' }, { number: 'WF8355', brand: 'WIX' }] })
      expect(catalog.listAnalogs('filter').map(item => item.id)).toEqual(['analog'])
      // І в зворотний бік: круг не бачить фільтр своїм аналогом.
      expect(catalog.listAnalogs('pad')).toEqual([])
    } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
