import { describe, expect, it } from 'vitest'
import { analyzeCatalogCleanup, type CleanupProduct } from '../src/repositories/catalogCleanupMatcher'

/**
 * Випадки з робочої бази власника (15.11.2026, 16 345 карток). Стара перевірка давала
 * 1617 груп: справжній дубль WA6684 стояв 1600-м із позначкою «різні бренди», двадцять
 * різних магнітол вважались «точним збігом», а одна картка входила у 108 груп.
 */
function product(id: string, name: string, extra: Partial<CleanupProduct> = {}): CleanupProduct {
  return { id, name, sku: null, barcode: null, brand: null, unit: 'шт', qty_on_hand: 0, purchase_price: 50, retail_price: 100, ...extra }
}
const groupOf = (products: CleanupProduct[], a: string, b: string) =>
  analyzeCatalogCleanup(products).groups.find(group => group.product_ids.includes(a) && group.product_ids.includes(b))

describe('owner catalog cases', () => {
  it('finds the WA6684 filter sold from a second card as a likely duplicate, not a brand conflict', () => {
    const cards = [
      product('a', 'Фільтр повітряний OPEL VIVARO A (X83) 1.9 DTI (F7) 2001', { sku: 'WA6684', barcode: '5050026343761', retail_price: 27000, purchase_price: 14200 }),
      product('b', 'Воздушный фильтр WIX WA6684 Renault', { sku: 'AUTO-D93906192CF64736A5D2BE08C68814FC', barcode: '2000998840877', retail_price: 24000, purchase_price: 14500 }),
      // Бренд «F» із довідника: раніше його знаходили в «(F7)» і оголошували конфлікт брендів.
      product('f', 'Засіб для чищення', { brand: 'F' }),
    ]
    const group = groupOf(cards, 'a', 'b')
    expect(group?.level).toBe('exact')
    expect(group?.conflicts).toEqual([])
    expect(group?.confidence).toBeGreaterThanOrEqual(80)
    expect(group?.reasons.join(' ')).toContain('Ціни відрізняються')
  })

  it('does not treat a vehicle make in the name as the product brand', () => {
    const group = groupOf([
      product('a', 'Фільтр масляний Skoda Fabia MAHLE OC264'),
      product('b', 'Фильтр масляный MAHLE OC264 Volkswagen Polo'),
    ], 'a', 'b')
    expect(group?.level).not.toBe('conflict')
    expect(group?.conflicts).toEqual([])
  })

  it('keeps radios with different model numbers apart even though the rest of the name is identical', () => {
    const radios = ['CSW-2302M', 'CSW-2601MT', 'CSW-2507M', 'CSW-243G', 'CSW-245B'].map((model, index) =>
      product('r' + index, `Бездисковий MP3/SD/USB/FM програвач Celsior ${model} Bluetooth`))
    const result = analyzeCatalogCleanup(radios)
    expect(result.groups.filter(group => group.level !== 'conflict')).toEqual([])
    // «MP3/SD/USB/FM» — перелік форматів, а не каталожний номер.
    expect(result.sku_suggestions.some(row => /MP3/i.test(row.sku))).toBe(false)
  })

  it('does not take a vehicle model range, a spec list or a diameter for a manufacturer number', () => {
    expect(groupOf([product('a', 'Шаровая опора нижняя ВАЗ 2101-07 HORT B101S'), product('b', 'Шаровая опора верхняя ВАЗ 2101-07 HORT B201S')], 'a', 'b')?.level ?? 'none').not.toBe('exact')
    expect(groupOf([product('a', 'Втулка клапанной крышки 2108-12 ASR'), product('b', 'Ключ регулировки натяжения ролика 2108-12')], 'a', 'b')).toBeUndefined()
    expect(groupOf([product('a', 'Диск сцепления TRIALLI 245-1601130 Sens/1102'), product('b', 'Диск сцепления Sens/1102 FSO 1102-1601130')], 'a', 'b')?.level ?? 'none').not.toBe('exact')
    expect(groupOf([product('a', 'Ролик ремня Ген CRB d77mm Aveo'), product('b', 'Ролик ремня Ген KOREA d77mm Aveo')], 'a', 'b')?.level ?? 'none').not.toBe('exact')
    const suggestions = analyzeCatalogCleanup([product('a', 'Масло Hypoid 75W90 GL-4/GL-5 1L'), product('b', 'Брызговик 2101-07 зад левый')]).sku_suggestions.map(row => row.sku)
    expect(suggestions).toEqual([])
  })

  it('never offers left and right, or upper and lower, parts as one product', () => {
    expect(groupOf([product('a', 'Брызговик задний левый NRD'), product('b', 'Брызговик задний правый NRD')], 'a', 'b')).toBeUndefined()
    const sharedBarcode = groupOf([product('a', 'Опора стойки верхняя CTR', { barcode: '4820000000017' }), product('b', 'Опора стойки нижняя CTR', { barcode: '4820000000017' })], 'a', 'b')
    expect(sharedBarcode?.level).toBe('conflict')
    expect(sharedBarcode?.conflicts).toContain('Різна сторона або розташування деталі')
  })

  it('treats a shared numeric OEM number from different makers as something to review, not a likely duplicate', () => {
    const group = groupOf([
      product('a', 'Шаровая опора АВТОЗАЗ 1102-2304024 ЗАЗ 1102'),
      product('b', 'Шаровая опора EXTRA 1102-2304024 ЗАЗ 1102'),
    ], 'a', 'b')
    expect(group?.level).toBe('review')
  })

  it('puts every card into one merge group only and lists the surest matches first', () => {
    const cards = [
      product('a', 'Фильтр масляный WIX WL7074 Amulet'),
      product('b', 'Фильтр масляный Амулет WIX WL7074'),
      product('c', 'Фильтр масляный WIX WL7074 PEUGEOT'),
      product('d', 'Очисник бітумних плям Антибітум PiTon 400мл'),
      product('e', 'Очисник бітумних плям Антибітум PiTon 400мл'),
      product('x', 'Термостат Fitshi', { barcode: '4820000000024' }),
      product('y', 'Термостат Fitshi', { barcode: '4820000000024' }),
    ]
    const groups = analyzeCatalogCleanup(cards).groups.filter(group => group.level !== 'conflict')
    const seen = groups.flatMap(group => group.product_ids)
    expect(new Set(seen).size).toBe(seen.length)
    expect(groups.find(group => group.product_ids.includes('a'))?.product_ids).toEqual(['a', 'b', 'c'])
    expect(groups.map(group => group.confidence)).toEqual([...groups.map(group => group.confidence)].sort((first, second) => second - first))
    expect(groups[0].product_ids).toEqual(['x', 'y'])
  })

  it('checks a catalog the size of the shop quickly enough to rerun after a correction', () => {
    const cards = Array.from({ length: 16000 }, (_, index) => product('p' + index, `Фільтр повітряний WIX WA${10000 + index} OPEL VIVARO ${index % 7} Bosch`, { sku: 'N' + index }))
    const started = Date.now()
    const result = analyzeCatalogCleanup(cards)
    // Раніше — близько 14 секунд на робочій базі через повторну компіляцію виразів для кожної картки.
    expect(Date.now() - started).toBeLessThan(6000)
    expect(result.stats.products).toBe(16000)
  })
})
