import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import { brandKey, loadConfirmedSkus, rememberConfirmedSku, supplierPrefixedSku } from '../src/repositories/aiInvoiceIdentity'

/** Етап 7 плану (22.11.2026): менше червоних рядків, але невпевнене не зв'язується саме. */
describe('fewer red invoice rows without losing accuracy', () => {
  let root: string, db: LocalDatabase, catalog: LocalCatalogRepository, supply: LocalSupplyRepository
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-ai-fewer-'))
    db = new LocalDatabase(root); catalog = new LocalCatalogRepository(db); supply = new LocalSupplyRepository(db)
  })
  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-ai-fewer-')) rmSync(root, { recursive: true, force: true })
  })
  const now = () => new Date().toISOString()
  const brand = (id: string, name: string) => db.prepare('INSERT INTO brands(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, DEFAULT_TENANT_ID, name, now(), now())
  const add = (id: string, sku: string, name: string, brandId?: string) => catalog.upsertProduct({ id, sku, name, qty_on_hand: 1, ...(brandId ? { brand_id: brandId } : {}) })
  const row = (data: Record<string, unknown>) => ({ qty: 1, purchase_price_uah: 100, ...data })
  const preview = (data: Record<string, unknown>) => supply.previewInvoiceFromAiRows({ rows: [row(data)] })[0]

  // 24.11.2026 (слово власника: «майже всі нові позиції червоні, а у списку — купа сміття, зовсім не схожого на товар»).
  it('a new product is created by itself when only common words match; the list shows the truly similar card first', () => {
    const cars = ['Ланос', 'Авео 1.5', 'Авео 1.6', 'Лачетти', 'Нубира', 'Джили МК', 'Джили СК', 'Эмгранд', 'Форза', 'Тигго', 'Матиз', 'Нексия']
    cars.forEach((car, index) => add('f' + index, String(79000 + index), 'Фильтр салона ' + car + ' Könner KCF-' + (7100 + index)))
    cars.slice(0, 6).forEach((car, index) => add('u' + index, String(84000 + index), 'Фильтр салона угольный ' + car + ' Könner'))
    add('amulet', '79388', 'Фильтр салона Амулет Könner')
    add('typo', '79342', 'Фильтр салона KFC 8113-C Chery Amulet KONNER')
    // Угольний фільтр на Амулет: потрібна картка — з кодом 8113 у назві, вона має бути першою; фільтри інших машин не показуємо.
    const carbon = preview({ name: 'Фильтр салона угольный Амулет Könner', sku: 'KCF-8113-C' })
    expect(carbon.status).toBe('review')
    expect(carbon.candidates[0].id).toBe('typo')
    expect(carbon.candidates.map(item => item.id)).toContain('amulet')
    expect(carbon.candidates.length).toBeLessThanOrEqual(5)
    expect(carbon.candidates.some(item => /Ланос|Авео|Нексия|Матиз/.test(item.name))).toBe(false)
    // Зовсім новий товар: спільні лише загальні слова — рядок не червоний, створюється сам.
    const fresh = preview({ name: 'Фильтр салона Чери Кимо Könner', sku: 'KCF-9977' })
    expect(fresh).toMatchObject({ status: 'new', candidates: [] })
    expect(fresh.validation_errors ?? []).toEqual([])
    // Майже та сама назва без артикула — як і раніше просимо звірити, щоб не створити дубль.
    expect(preview({ name: 'Фильтр салона Амулет Könner (упаковка)', sku: '' })).toMatchObject({ status: 'review' })
  })

  it('recognises a supplier brand prefix only in front of a real part number', () => {
    expect(supplierPrefixedSku('MF HU719/7X')).toBe('HU719/7X')
    expect(supplierPrefixedSku('WX WL7125')).toBe('WL7125')
    expect(supplierPrefixedSku('GT 6PK1270')).toBe('6PK1270')
    expect(supplierPrefixedSku('VR 71-40854-00')).toBe('71-40854-00')
    for (const notPrefixed of ['HU719/7X', 'EL 101 514', 'MF 12', 'AB CD', 'MANN HU719/7X', 'MF (12)', '']) expect(supplierPrefixedSku(notPrefixed)).toBe('')
  })

  it('treats spellings of one brand as the same brand and keeps different brands apart', () => {
    expect(brandKey('WIXFILTRON')).toBe(brandKey('WIX'))
    expect(brandKey('Knecht')).toBe(brandKey('MAHLE'))
    expect(brandKey('MANN-FILTER')).toBe(brandKey('Mann'))
    expect(brandKey('LEMFÖRDER')).toBe(brandKey('Lemfoerder'))
    expect(brandKey('VICT_REINZ')).toBe(brandKey('Victor Reinz'))
    expect(brandKey('SACHS')).not.toBe(brandKey('LEMFÖRDER'))
    expect(brandKey('WIX')).not.toBe(brandKey('MANN'))
  })

  it('links "MF HU719/7X" to the single MANN card HU719/7X and a WIXFILTRON line to a WIX card', () => {
    brand('b-mann', 'MANN'); brand('b-wix', 'WIX')
    add('p-mann', 'HU719/7X', 'Фільтр масляний MANN HU719/7X', 'b-mann')
    add('p-wix', 'WL7125', 'Фільтр масляний WIX WL7125', 'b-wix')
    expect(preview({ name: 'Фільтр масляний', brand: 'MANN', sku: 'MF HU719/7X' })).toMatchObject({ status: 'matched', product_id: 'p-mann' })
    expect(preview({ name: 'Фільтр масляний', brand: 'WIXFILTRON', sku: 'WX WL7125' })).toMatchObject({ status: 'matched', product_id: 'p-wix' })
    // The exact article with a brand synonym no longer needs a review either.
    expect(preview({ name: 'Фільтр масляний', brand: 'WIXFILTRON', sku: 'WL7125' })).toMatchObject({ status: 'matched', product_id: 'p-wix' })
  })

  it('never links a prefixed article to a card of another brand or when several cards fit', () => {
    brand('b-mann', 'MANN'); brand('b-bosch', 'BOSCH')
    add('p-bosch', 'HU719/7X', 'Фільтр масляний BOSCH HU719/7X', 'b-bosch')
    const otherBrand = preview({ name: 'Фільтр масляний', brand: 'MANN', sku: 'MF HU719/7X' })
    expect(otherBrand.status).not.toBe('matched')
    expect(otherBrand.product_id).toBeNull()
    add('p-a', '6PK1270', 'Ремінь поліклиновий 6PK1270 короткий')
    add('p-b', 'X-77', 'Ремінь поліклиновий Gates 6PK1270 довгий')
    const several = preview({ name: 'Ремінь поліклиновий', sku: 'GT 6PK1270' })
    expect(several.status).not.toBe('matched')
    expect(several.product_id).toBeNull()
  })

  it('remembers an article the owner confirmed and links the next invoice by itself', () => {
    brand('b-ks', 'KS')
    add('p-ks', 'INT-0001', 'Фільтр паливний KS 50013967 дизель', 'b-ks')
    add('p-other', 'INT-0002', 'Фільтр паливний KS 50013968 бензин', 'b-ks')
    const line = { name: 'Фільтр паливний', brand: 'KS', sku: 'KS-FP/77' }
    expect(preview(line).status).not.toBe('matched')
    rememberConfirmedSku(db, DEFAULT_TENANT_ID, 'p-ks', line)
    expect(loadConfirmedSkus(db, DEFAULT_TENANT_ID).size).toBe(1)
    expect(preview(line)).toMatchObject({ status: 'matched', product_id: 'p-ks', reason: 'Цей артикул ви вже підтверджували для цієї картки' })
    // Another brand with the same article is a different product and stays unlinked.
    expect(preview({ ...line, brand: 'BOSCH' }).status).not.toBe('matched')
  })

  it('does not remember line numbers or pack codes, and drops the memory when the card is gone', () => {
    add('p-1', 'INT-0003', 'Хомут черв\'ячний 10-16 мм')
    for (const sku of ['12', '(12)', 'AI-1A2B3C4D', '']) rememberConfirmedSku(db, DEFAULT_TENANT_ID, 'p-1', { name: 'Хомут', sku })
    expect(loadConfirmedSkus(db, DEFAULT_TENANT_ID).size).toBe(0)
    const line = { name: 'Хомут червячний', sku: 'NORMA-1016' }
    rememberConfirmedSku(db, DEFAULT_TENANT_ID, 'p-1', line)
    expect(preview(line)).toMatchObject({ status: 'matched', product_id: 'p-1' })
    catalog.deleteProduct('p-1')
    expect(preview(line).product_id).toBeNull()
  })

  it('shows the card whose cross number equals the article first, but never links an analog by itself', () => {
    brand('b-mann', 'MANN')
    add('p-mann', 'W712/83', 'Фільтр масляний MANN W712/83', 'b-mann')
    add('p-noise', 'INT-0009', 'Фільтр масляний універсальний короткий')
    catalog.changeCrossNumbers('p-mann', { add: ['WL7125'] })
    const result = preview({ name: 'Фільтр масляний', brand: 'WIX', sku: 'WX WL7125' })
    expect(result.status).toBe('review')
    expect(result.product_id).toBeNull()
    expect(result.candidates[0].id).toBe('p-mann')
    expect(result.reason).toContain('крос-номерів')
  })
})
