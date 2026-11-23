import { describe, expect, it } from 'vitest'
import { crossNumbersText, groupCrossNumbers, parseCrossPaste } from './crossNumberBrands'

// 23.11.2026, слово власника: «у постачальників: Hyundai — крос-номери всі через кому, потім Kia — всі через кому,
// потім MANN, Bosch, Blue Print… не треба щоразу писати бренд біля коду».
describe('cross numbers brand by brand', () => {
  it('reads the suppliers form: a brand, a colon, its numbers through commas', () => {
    expect(parseCrossPaste('Hyundai: 26300-35503, 26300-35504\nKia: 26300-35530; MANN: W 811/80')).toEqual([
      { number: '26300-35503', brand: 'Hyundai' }, { number: '26300-35504', brand: 'Hyundai' },
      { number: '26300-35530', brand: 'Kia' }, { number: 'W 811/80', brand: 'MANN' },
    ])
  })

  it('plain lists still work, repeats are dropped, a time or a sentence is not a brand', () => {
    expect(parseCrossPaste('96182220\n94788122, OC90\toc-90')).toEqual([
      { number: '96182220', brand: null }, { number: '94788122', brand: null }, { number: 'OC90', brand: null },
    ])
    expect(parseCrossPaste('12:30')).toEqual([{ number: '12:30', brand: null }])
    expect(parseCrossPaste('Blue Print: ADG02109')).toEqual([{ number: 'ADG02109', brand: 'Blue Print' }])
    expect(parseCrossPaste('  \n ; ')).toEqual([])
  })

  it('groups for the card: brands in the order they appear, numbers without a brand last', () => {
    const groups = groupCrossNumbers([
      { number: 'A1', brand: null }, { number: 'H1', brand: 'Hyundai' }, { number: 'B1', brand: 'BLUE PRINT' },
      { number: 'H2', brand: 'hyundai' }, { number: 'B2', brand: 'Blue Print' },
    ])
    expect(groups.map(group => [group.brand, group.items.map(item => item.number)])).toEqual([
      ['Hyundai', ['H1', 'H2']], ['BLUE PRINT', ['B1', 'B2']], ['', ['A1']],
    ])
  })

  it('copies the whole list in the same form', () => {
    expect(crossNumbersText([{ number: 'H1', brand: 'Hyundai' }, { number: 'K1', brand: 'Kia' }, { number: 'H2', brand: 'Hyundai' }, { number: 'X9' }]))
      .toBe('Hyundai: H1, H2; Kia: K1; Інші: X9')
    expect(crossNumbersText([{ number: 'A1' }, { number: 'A2' }])).toBe('A1, A2')
    // Що скопіювали з картки — можна вставити в іншу картку без втрат.
    const text = crossNumbersText([{ number: 'H1', brand: 'Hyundai' }, { number: 'K1', brand: 'Kia' }])
    expect(parseCrossPaste(text)).toEqual([{ number: 'H1', brand: 'Hyundai' }, { number: 'K1', brand: 'Kia' }])
  })
})
