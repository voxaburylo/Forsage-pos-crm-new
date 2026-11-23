import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CROSS_NUMBERS_PER_PRODUCT, CROSS_RESEARCH_PRODUCTS, cleanCrossProposal, crossResearchSearches, groupCrossNumbersByBrand,
} from '../aiCrossNumberRules.js'

// 23.11.2026, слово власника: помічник «знаходить буквально 10 крос-номерів і вважає, що все — цього дуже мало;
// лише за оригіналом буває до 20 (Kia, Hyundai, Mitsubishi…)»; і «не треба писати Blue Print біля кожного коду —
// як у постачальників: Hyundai — усі через кому, потім Kia, потім MANN, Bosch…».
describe('cross numbers are written brand by brand', () => {
  it('names a brand once and lists its numbers through commas, in the order the brands first appear', () => {
    expect(groupCrossNumbersByBrand([
      { number: '26300-35503', brand: 'Hyundai' }, { number: '26300-35530', brand: 'Kia' },
      { number: '26300-35504', brand: 'Hyundai' }, { number: 'W 811/80', brand: 'MANN' },
      { number: 'ADG02109', brand: 'Blue Print' }, { number: 'ADG02110', brand: 'BLUE PRINT' }, { number: 'ADG02121', brand: 'Blueprint' },
    ])).toBe('Hyundai: 26300-35503, 26300-35504; Kia: 26300-35530; MANN: W 811/80; Blue Print: ADG02109, ADG02110, ADG02121')
  })

  it('keeps numbers without a brand at the end and repeats nothing', () => {
    expect(groupCrossNumbersByBrand([{ number: 'A1' }, { number: 'B2', brand: 'BOSCH' }, { number: 'A1', brand: null }, { number: 'B2', brand: 'Bosch' }]))
      .toBe('BOSCH: B2; Інші: A1')
    expect(groupCrossNumbersByBrand([{ number: 'A1' }, { number: 'A2', brand: ' ' }])).toBe('A1, A2')
    expect(groupCrossNumbersByBrand([])).toBe('')
  })

  it('the proposal shown to the owner uses this form, not «number (brand)» for every number', () => {
    const service = readFileSync(new URL('../aiService.ts', import.meta.url), 'utf8')
    expect(service).toContain("'Крос-номери': groupCrossNumbersByBrand(item.numbers),")
    expect(service).not.toContain('`${n.number} (${n.brand})`')
    expect(service).toContain('не пиши бренд біля кожного номера')
  })
})

describe('the search goes deeper', () => {
  it('fewer products per search and several searches for each of them', () => {
    expect(CROSS_RESEARCH_PRODUCTS).toBe(3)
    expect([1, 2, 3].map(crossResearchSearches)).toEqual([7, 11, 15])
    // Жоден виклик не просить більше, ніж витримує ліміт часу однієї відповіді.
    expect(crossResearchSearches(50)).toBe(15)
    expect(crossResearchSearches(0)).toBe(7)
    const service = readFileSync(new URL('../aiService.ts', import.meta.url), 'utf8')
    expect(service).toContain('.slice(0, CROSS_RESEARCH_PRODUCTS)')
    expect(service).toContain('crossResearchPrompt(lines), crossResearchSearches(ids.length))')
  })

  it('a product keeps far more than ten confirmed numbers', () => {
    expect(CROSS_NUMBERS_PER_PRODUCT).toBeGreaterThanOrEqual(100)
    const numbers = Array.from({ length: 60 }, (_, index) => ({ number: 'OE-' + (1000 + index), brand: index < 20 ? 'Hyundai' : 'MANN', source_url: 'https://avtopro.ua/part/' + index }))
    const [item] = cleanCrossProposal([{ product_id: 'p1', numbers }])
    expect(item.numbers).toHaveLength(60)
  })
})
