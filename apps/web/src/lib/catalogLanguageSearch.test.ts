import { describe, it, expect } from 'vitest'
import { CATALOG_LANGUAGE_GROUPS, catalogLanguageTokenGroups, normalizeCatalogLanguage } from '../../../desktop/src/lib/catalogLanguageSearch'
import { offlineProductMatchesQuery } from './offlineDB'

describe('Russian/Ukrainian catalog vocabulary', () => {
  it.each(CATALOG_LANGUAGE_GROUPS)('is bidirectional: %s', line => {
    const words = line.split(' ')
    for (const a of words) for (const b of words) {
      expect(catalogLanguageTokenGroups(a)[0]).toContain(normalizeCatalogLanguage(b))
    }
  })
  it.each([
    ['ремень gates 6PK1873', 'Ремінь поліклиновий Gates 6PK1873'],
    ['колодки тормозные передние', 'Передні гальмівні колодки'],
    ['масляный фильтр', 'Фільтр оливний'],
    ['підшипник маточини', 'Подшипник ступицы'],
  ])('matches all translated tokens: %s', (query, name) => {
    expect(offlineProductMatchesQuery({ name }, query)).toBe(true)
  })
  it('does not drop numbers, left/right or extra words', () => {
    expect(offlineProductMatchesQuery({ name: 'Ремінь 6PK1873' }, 'ремень 6PK1874')).toBe(false)
    expect(offlineProductMatchesQuery({ name: 'Лівий наконечник' }, 'правый наконечник')).toBe(false)
    expect(offlineProductMatchesQuery({ name: 'Фільтр повітряний' }, 'масляный фильтр')).toBe(false)
    expect(catalogLanguageTokenGroups('2003093555486')).toEqual([['2003093555486']])
  })
})
