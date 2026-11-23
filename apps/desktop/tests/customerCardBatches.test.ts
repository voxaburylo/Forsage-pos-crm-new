import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import {
  CARD_BATCH_MAX, CARD_DIGITS10_PREFIX, CARD_EAN_PREFIX, cardBatchCodes, ean13CheckDigit, generateCardBatch, isFreeCard, isValidEan13,
  listCardBatches, makeCardCode,
} from '../src/repositories/customerCardBatches'

// 23.11.2026 (план B2): пачки штрихкодів для карток клієнтів — для друкарні.
describe('customer card batches', () => {
  let root: string
  let db: LocalDatabase
  const now = '2026-11-23T12:00:00.000Z'
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-card-batches-'))
    db = new LocalDatabase(root)
  })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

  function addCustomer(id: string, card: string | null, deleted = false) {
    db.prepare(`INSERT INTO customers(id,tenant_id,full_name,phone,card_barcode,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, DEFAULT_TENANT_ID, 'Клієнт ' + id, '+38067000' + id.padStart(4, '0'), card, deleted ? now : null, now, now)
  }
  /** Послідовність цифр замість випадку: видно, які саме коди пробує генератор. */
  function scripted(...codes: string[]) {
    const queue = codes.join('').split('').map(Number)
    return () => { if (!queue.length) throw new Error('script ended'); return queue.shift()! }
  }

  it('the check digit is the standard EAN-13 one', () => {
    expect(ean13CheckDigit('400638133393')).toBe('1')
    expect(ean13CheckDigit('590123412345')).toBe('7')
    expect(isValidEan13('4006381333931')).toBe(true)
    expect(isValidEan13('4006381333932')).toBe(false)
    expect(isValidEan13('400638133393')).toBe(false)
    expect(() => ean13CheckDigit('12')).toThrow()
  })

  it('13 digits: own start «29», a valid check digit; 10 digits: start «77», never a phone-like «0…»', () => {
    for (let index = 0; index < 200; index++) {
      const long = makeCardCode('ean13')
      expect(long).toMatch(/^29\d{11}$/)
      expect(isValidEan13(long)).toBe(true)
      // Власні штрихкоди товарів починаються на «200» — картки з ними не перетинаються вже за початком.
      expect(long.startsWith('200')).toBe(false)
      expect(makeCardCode('digits10')).toMatch(/^77\d{8}$/)
    }
    expect(CARD_EAN_PREFIX).toBe('29')
    expect(CARD_DIGITS10_PREFIX).toBe('77')
  })

  it('a batch has exactly the asked number of different codes and is remembered', () => {
    const batch = generateCardBatch(db, { count: 1000, format: 'ean13', createdBy: 'owner-1' }, { now: () => new Date(now) })
    expect(batch.codes).toHaveLength(1000)
    expect(new Set(batch.codes).size).toBe(1000)
    expect(batch.codes.every(isValidEan13)).toBe(true)
    expect(cardBatchCodes(db, batch.id)).toEqual(batch.codes)
    expect(listCardBatches(db)).toEqual([{ id: batch.id, created_at: now, format: 'ean13', count: 1000, linked: 0 }])
  })

  it('never issues a code that a customer, a product or an earlier batch already has', () => {
    addCustomer('1', '7700000001')
    addCustomer('2', '7700000002', true) // картка видаленого клієнта теж фізично існує
    const t = new Date(now).toISOString()
    db.prepare(`INSERT INTO products(id,tenant_id,sku,name,barcode,retail_price,created_at,updated_at) VALUES('p1',?,'S1','Товар','7700000003',100,?,?)`).run(DEFAULT_TENANT_ID, t, t)
    db.prepare(`INSERT INTO product_barcodes(id,tenant_id,product_id,barcode,created_at,updated_at) VALUES('b1',?,'p1','7700000004',?,?)`).run(DEFAULT_TENANT_ID, t, t)
    const first = generateCardBatch(db, { count: 1, format: 'digits10' }, { random: scripted('00000001', '00000002', '00000003', '00000004', '00000005') })
    expect(first.codes).toEqual(['7700000005'])
    // Друга пачка: той самий код уже видано — береться наступний; повтор усередині пачки теж відкидається.
    const second = generateCardBatch(db, { count: 2, format: 'digits10' }, { random: scripted('00000005', '00000006', '00000006', '00000007') })
    expect(second.codes).toEqual(['7700000006', '7700000007'])
  })

  it('refuses a wrong amount or format, and stops instead of spinning when free codes do not come', () => {
    for (const count of [0, -1, 1.5, CARD_BATCH_MAX + 1, 'abc', null]) expect(() => generateCardBatch(db, { count, format: 'ean13' })).toThrow('Кількість карток')
    for (const format of ['', 'ean8', undefined, 13]) expect(() => generateCardBatch(db, { count: 1, format })).toThrow('Оберіть формат')
    addCustomer('1', '7700000000')
    expect(() => generateCardBatch(db, { count: 1, format: 'digits10' }, { random: () => 0 })).toThrow('Не вдалося підібрати')
    expect(listCardBatches(db)).toEqual([])
  })

  it('the batch list counts cards already given to customers; newest first', () => {
    const old = generateCardBatch(db, { count: 3, format: 'digits10' }, { now: () => new Date('2026-11-01T10:00:00.000Z') })
    const fresh = generateCardBatch(db, { count: 2, format: 'ean13' }, { now: () => new Date('2026-11-20T10:00:00.000Z') })
    addCustomer('1', old.codes[0])
    addCustomer('2', old.codes[1], true) // видалений клієнт не рахується як прив'язаний
    expect(listCardBatches(db).map(row => [row.id, row.count, row.linked])).toEqual([[fresh.id, 2, 0], [old.id, 3, 1]])
  })

  it('a scanned code is a «free card» only while it is from a batch and not yet given to a customer', () => {
    const batch = generateCardBatch(db, { count: 2, format: 'ean13' })
    const [given, free] = batch.codes
    expect(isFreeCard(db, free)).toBe(true)
    expect(isFreeCard(db, ` ${free.slice(0, 6)} ${free.slice(6)} `)).toBe(true)
    addCustomer('1', given)
    expect(isFreeCard(db, given)).toBe(false)
    for (const other of ['4006381333931', '', null, 'abc', "x' OR 1=1"]) expect(isFreeCard(db, other)).toBe(false)
  })

  it('a broken stored batch does not hide the others, and a made-up batch id is refused', () => {
    const batch = generateCardBatch(db, { count: 1, format: 'ean13' })
    db.prepare("INSERT INTO app_meta(key,value_json,updated_at) VALUES('customer-card-batch:v1:broken','{not json',?)").run(now)
    expect(listCardBatches(db).map(row => row.id)).toEqual([batch.id])
    expect(() => cardBatchCodes(db, 'broken')).toThrow('Некоректна пачка')
    expect(() => cardBatchCodes(db, '00000000-0000-4000-8000-000000000000')).toThrow('не знайдено')
  })
})
