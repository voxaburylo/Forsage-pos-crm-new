import { describe, expect, it } from 'vitest'
import { categoryIndex, nameHead, ruleCategoryId, ruleCategoryName } from './categoryByName.js'

// 26.11.2026, слово власника: «товари зі зрозумілою назвою хай розбирає алгоритм, без штучного інтелекту».
// Приклади — справжні назви з товарів постачальників (прогін на 63 813 товарах: алгоритм розклав 33 964).
describe('category by a clear name, without AI', () => {
  it.each([
    ['Гальмівні колодки WOKING дискові (P13713.02)', 'Колодки'],
    ['Колодка гальм. диск. CHEVROLET CAPTIVA задн. (вир-во REMSA)', 'Колодки'],
    ['Диск гальмівний MB VITO 96-03 задн. (RIDER)', 'Гальмівна система'],
    ['Супорт гальм. прав. (вир-во ABS)', 'Гальмівна система'],
    ['Сайлентблок важеля підвіски SPIDAN (412270) s', 'Сайлентблок'],
    ['Важіль підвіски AUDI A1, A3, Q3 перед. міст', 'Важіль'],
    ['Тяга стабілізатора FORD GALAXY, VW SHARAN 95-10', 'Стійка стабілізатора'],
    ['Стiйка стабiлiзатора DAINTON (D200154)', 'Стійка стабілізатора'],
    ['Наконечник рульової тяги лівий SPIDAN (51090)', 'Рульовий наконечник'],
    ['Тяга рульова VW GOLF III-IV', 'Рульова тяга'],
    ['Пильовик ШРКШ внутр. NISSAN (вир-во FEBEST)', 'Пильовики'],
    ['Фільтр оливи WIX FILTERS Honda Accord VIII', 'Фільтри'],
    ['Фильтр воздушный Bosch', 'Фільтри'],
    ['Лампа автомобільна NARVA 24V R10W 10W BA15S', 'Лампочки'],
    ['Підшипник генератора Fenox ГАЗ 402 великий', 'Підшипники'],
    ['Ремінь генератора Daewoo Lanos 1,6 AT (5PK1013)', 'Ремені'],
    ['Свічка розжарювання AUTOMEGA (150066210)', 'Запалювання'],
    ['Акумулятор 77Ah-12v VARTA Dynamic SLI (E44)', 'АКБ'],
    ['Олива моторна MOBIL Ultra SL/CF 10W-40 4 л', 'Оливи-ATF'],
    ['Шина 315/80R22,5 156L154M ORJAK 5 M+S', 'Шини'],
  ])('%s → %s', (name, category) => { expect(ruleCategoryName(name)).toBe(category) })

  it.each([
    'Р/к гальмівної колодки ЗІЛ,ПАЗ (5 найменувань) (DETALKA)', // ремкомплект — не сама колодка
    'Ремкомплект, гальмівний супорт D41618C (вир-во ERT)',
    'Комплект зчеплення LUK',
    'Датчик зносу гальмівних колодок+',                          // це датчик… і правило «колодки» його не чіпає
    'Акумулятор Duracell HR6 (AA) 1300 mAh Blister 2 шт',        // батарейка, а не АКБ
    'Акумулятор до YT-30417 YATO Li-Ion 3.7 V',
    'Амортизатор багажника FEBI',                                // газовий упор
    'Важіль склоочисника задній',
    'Відбійник двигуна VAG (вир-во FEBI)',
    'Втулка центрувальна маточини BILSTEIN (07636)',
    'Трос буксирувальний 13 т 6 м',
    'Ремінь безпеки передній',
    'VALEO 700431',                                              // назва з бренду й коду — виду немає
    'Кронштейн бампера',
  ])('the algorithm does not guess: %s', name => {
    const guess = ruleCategoryName(name)
    expect(guess === null || (name.startsWith('Датчик') && guess === 'Датчики')).toBe(true)
  })

  it('looks only at the beginning of the name; Latin «i» inside Ukrainian words is read as «і»', () => {
    expect(nameHead('Стiйка стабiлiзатора DAINTON (D200154)')).toBe('стійка стабілізатора')
    expect(nameHead('Hyundai/Kia 26300-35505 Фільтр масляний для авто з двигуном')).toBe('фільтр масляний для авто')
  })

  it('the category is found by its exact name; a missing or doubled category keeps the rule silent', () => {
    const index = categoryIndex([{ id: 'c1', path: 'Гальма › Колодки' }, { id: 'c2', path: 'Фільтри' }, { id: 'c3', path: 'Шини' }, { id: 'c4', path: 'Старе › Шини' }])
    expect(ruleCategoryId('Гальмівні колодки TOMEX дискові', index)).toBe('c1')
    expect(ruleCategoryId('Фільтр паливний AUTOMEGA', index)).toBe('c2')
    expect(ruleCategoryId('Шина 205/55R16', index)).toBeNull()          // дві категорії «Шини» — хай вирішує не алгоритм
    expect(ruleCategoryId('Сайлентблок важеля', index)).toBeNull()      // такої категорії в магазині немає
  })
})
