import { describe, expect, it } from 'vitest'
import { analyzeCatalogCleanup, type CleanupProduct } from '../src/repositories/catalogCleanupMatcher'

function product(id: string, name: string, extra: Partial<CleanupProduct> = {}): CleanupProduct {
  return { id, name, sku: null, barcode: null, brand: null, unit: 'шт', qty_on_hand: 0, purchase_price: 50, retail_price: 100, ...extra }
}
function pair(a: CleanupProduct, b: CleanupProduct) {
  return analyzeCatalogCleanup([a, b]).groups.find(group => group.product_ids.includes(a.id) && group.product_ids.includes(b.id))
}
describe('catalog cleanup identity evidence', () => {
  it('recognizes the Ukrainian/Russian Balaton example including an attached size and brand', () => {
    const a = product('a', 'Груша підкачки Balaton10мм Г-образна', { brand: 'Balaton' })
    const b = product('b', 'груша подкачки Balaton 10 мм Г-образная')
    expect(pair(a, b)).toMatchObject({ level: 'exact', product_ids: ['a', 'b'], conflicts: [] })
  })
  it('matches technical synonyms and word order, preserving explicit barcode evidence', () => {
    const a = product('a', 'Фільтр паливний WIX WA9428', { sku: 'WA-9428', brand: 'WIX', barcode: '123456' })
    const b = product('b', 'WIX топливный фильтр WA9428', { additional_barcodes: ['123456'], brand: 'Wix' })
    const result = pair(a, b)
    expect(result?.level).toBe('exact')
    expect(result?.reasons.join(' ')).toMatch(/штрихкод/)
  })
  it('does not interpret 10ми as 10мм, and identical unknown units still require review', () => {
    expect(pair(product('a', 'Груша Balaton 10ми'), product('b', 'Груша Balaton 10ми'))?.level).toBe('review')
    expect(pair(product('a', 'Груша Balaton 10ми'), product('b', 'Груша Balaton 10мм'))?.level).not.toBe('exact')
    expect(pair(product('a', 'Груша Balaton 10ммм'), product('b', 'Груша Balaton 10ммм'))?.level).toBe('review')
  })
  it('preserves attached polarity symbols and does not confuse synthetic oil with blue colour', () => {
    expect(pair(product('a', 'Клема АКБ+', { barcode: 'same' }), product('b', 'Клема АКБ-', { barcode: 'same' }))?.level).toBe('conflict')
    expect(pair(product('a', 'Олива синтетична Mannol 5W30 1л'), product('b', 'Олива синя Mannol 5W30 1л'))?.level).not.toBe('exact')
  })
  it.each([
    ['Груша Balaton 10мм Г-образна', 'Груша Balaton 8мм Г-образна', /розмір|характеристик/i],
    ['Груша Balaton 10мм Г-образна', 'Груша Balaton 10мм пряма', /форм/i],
    ['Клема акумулятора +', 'Клема акумулятора -', /полярн/i],
    ['Гайка колеса чорна M12', 'Гайка колеса хром M12', /колір|покритт/i],
    ['Олива Mannol ATF 1л', 'Олива Mannol ATF 4л', /розмір|характеристик/i],
    ['Ремкомплект супорта 2шт', 'Ремкомплект супорта 1шт', /розмір|характеристик/i],
    ['Фільтр Bosch 10мм', 'Фільтр WIX 10мм', /бренд/i],
    ['Груша Balaton 10мм', 'Груша Balaton 10мм', /одиниц/i, 'к-т'],
  ])('does not let the same barcode hide conflicting identity: %s vs %s', (left: string, right: string, conflict: RegExp, unit?: string) => {
    const result = pair(product('a', left, { barcode: 'SHARED' }), product('b', right, { barcode: 'SHARED', unit: unit ?? 'шт' }))
    expect(result?.level).toBe('conflict')
    expect(result?.conflicts.join(' ')).toMatch(conflict as RegExp)
  })
  it('does not merge an unknown variant into both ends of a contradictory chain', () => {
    const result = analyzeCatalogCleanup([
      product('a', 'Олива Mannol 1л', { sku: 'AB123456' }),
      product('b', 'Олива Mannol', { sku: 'AB123456' }),
      product('c', 'Олива Mannol 4л', { sku: 'AB123456' }),
    ])
    expect(result.groups.some(group => group.product_ids.length === 3)).toBe(false)
    expect(result.groups.find(group => group.product_ids.includes('a') && group.product_ids.includes('c'))?.level).toBe('conflict')
  })
  it('keeps leading barcode zeros and does not equate separate products by a short generic article', () => {
    const result = analyzeCatalogCleanup([
      product('a', 'Фільтр Bosch', { barcode: '001234', sku: '44' }),
      product('b', 'Резонатор Polmo', { barcode: '1234', sku: '44' }),
    ])
    expect(result.groups).toEqual([])
  })
  it('distinguishes an explicit brand conflict inside one card', () => {
    const result = pair(product('a', 'Фільтр WIX WA9428', { brand: 'Bosch', barcode: '123' }), product('b', 'Фільтр WIX WA9428', { brand: 'WIX', barcode: '123' }))
    expect(result?.level).toBe('conflict')
  })
  it('does not treat legacy AUTO placeholders as contradictory genuine articles', () => {
    expect(pair(product('a', 'Фільтр WIX WA9428', { sku: 'AUTO-101' }), product('b', 'Фільтр WIX WA9428', { sku: 'WA9428' }))?.level).toBe('exact')
    const suggestions = analyzeCatalogCleanup([product('a', 'Фільтр WIX WA9428', { sku: 'AUTO-101' })]).sku_suggestions
    expect(suggestions[0].blocked).toBeUndefined()
  })
  it('reviews different internal field articles without overriding explicit contradictory articles', () => {
    expect(pair(product('a', 'Груша Balaton 10мм', { sku: '88897' }), product('b', 'Груша Balaton 10мм', { sku: '106030' }))?.level).toBe('review')
    expect(pair(product('a', 'Фільтр арт. WA9428', { sku: 'OTHER999' }), product('b', 'Фільтр арт. WA9428', { sku: 'WA9428' }))?.level).toBe('conflict')
  })
  it('is deterministic, does not mutate inputs, and does not select the target by guessed quantity', () => {
    const products = [product('z', 'Груша Balaton 10мм', { created_at: '2026-01-01', qty_on_hand: 0 }), product('a', 'Груша Balaton 10мм', { created_at: '2026-10-01', qty_on_hand: 99 })]
    const before = JSON.stringify(products)
    products.forEach(Object.freeze); Object.freeze(products)
    const result = analyzeCatalogCleanup(products)
    expect(result).toEqual(analyzeCatalogCleanup([...products].reverse()))
    expect(result.groups[0].suggested_target_id).toBe('z')
    expect(JSON.stringify(products)).toBe(before)
  })
})

describe('conservative article proposals', () => {
  it('extracts a catalog article already present in the name with explicit evidence', () => {
    const result = analyzeCatalogCleanup([product('a', 'Фільтр паливний WIX арт. WA9428'), product('b', 'Олива Mannol 8206-1 DEXRON III ATF 1L')])
    expect(result.sku_suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ product_id: 'a', sku: 'WA9428', evidence: expect.stringContaining('WA9428') }),
      expect.objectContaining({ product_id: 'b', sku: '8206-1', evidence: expect.stringContaining('8206-1') }),
    ]))
  })
  it.each(['Олива 10W40 4L', 'Мотор F16D3 1.6л', 'Помпа K4M Renault', 'Прокладка ВАЗ2108', 'Гайка M12x1.25x16', 'Автошина 155/70R13', 'Лампа H7 12V 55W', 'Антифриз G12+ 1л', 'Опора ВАЗ 2108-2115', 'Датчик фаз 1117-1119', 'Пильник ШРУС 1117-1119'])('does not suggest a model, engine, size or specification as article: %s', name => {
    expect(analyzeCatalogCleanup([product('a', name)]).sku_suggestions).toEqual([])
  })
  it('does not replace an occupied article and blocks codes already owned by another card', () => {
    const result = analyzeCatalogCleanup([
      product('a', 'Фільтр арт. WA9428', { sku: 'OTHER999' }),
      product('b', 'Фільтр повітряний', { sku: 'WA9428' }),
      product('c', 'Фільтр WA9428'),
    ])
    expect(result.sku_suggestions.find(row => row.product_id === 'a')?.blocked).toMatch(/заповнен/)
    expect(result.sku_suggestions.find(row => row.product_id === 'c')?.blocked).toMatch(/інш|належ/)
  })
})

describe('bounded candidate comparison', () => {
  it('does not flood duplicate review with distinct variants sharing generic words', () => {
    const products = Array.from({ length: 60 }, (_, index) => product(String(index), `Фільтр паливний Balaton ${index + 1}мм`, { brand: 'Balaton' }))
    const result = analyzeCatalogCleanup(products)
    expect(result.groups).toEqual([])
    expect(result.stats.candidate_pairs).toBeLessThan(500)
  })
  it('handles 15000 cards without an all-pairs scan and discloses oversized blocks', () => {
    const products = Array.from({ length: 15_000 }, (_, index) => product(String(index).padStart(5, '0'), index < 100 ? 'Товар без маркування' : `Товар категорії ${index}`, { barcode: String(2000000000000 + index) }))
    const started = Date.now(), result = analyzeCatalogCleanup(products)
    expect(result.stats.products).toBe(15_000)
    expect(result.stats.candidate_pairs).toBeLessThan(150_000)
    expect(result.stats.skipped_large_blocks).toBeGreaterThan(0)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(Date.now() - started).toBeLessThan(6000)
  })
  it('groups 15000 cards in distinct duplicate pairs without scanning the whole catalog for each group', () => {
    const products = Array.from({ length: 15_000 }, (_, index) => product(String(index).padStart(5, '0'), `Груша Balaton серія ${Math.floor(index / 2)} 10мм`))
    const started = Date.now(), result = analyzeCatalogCleanup(products)
    expect(result.groups.length).toBe(7500)
    expect(result.groups.every(group => group.product_ids.length === 2 && group.level === 'exact')).toBe(true)
    expect(Date.now() - started).toBeLessThan(6000)
  })
  it('rejects duplicate identities instead of producing ambiguous group membership', () => {
    expect(() => analyzeCatalogCleanup([product('same', 'Товар'), product('same', 'Інший товар')])).toThrow(/ідентифікатор/i)
  })
})
