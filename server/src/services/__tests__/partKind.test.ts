import { describe, expect, it } from 'vitest'
import { kindsConflict, namesConflict, partKind, pickCrossRows } from '../partKind.js'

// 26.11.2026, слово власника: «крос-номери мають враховувати й запчастину — щоб до фільтрів не підтягувались колодки».
describe('part kind from the name', () => {
  it('recognises the kind in Ukrainian and Russian names', () => {
    expect(partKind('Фільтр масляний MANN W 712/75')).toEqual({ group: 'filter', sub: 'oil' })
    expect(partKind('Фильтр воздушный Bosch s 0123')).toEqual({ group: 'filter', sub: 'air' })
    expect(partKind('Фільтр салону вугільний')).toEqual({ group: 'filter', sub: 'cabin' })
    expect(partKind('Фильтр WIX WL7131')).toEqual({ group: 'filter', sub: null })
    expect(partKind('Колодки гальмівні передні Ferodo')).toEqual({ group: 'brake_pads', sub: null })
    expect(partKind('Тормозные колодки задние')).toEqual({ group: 'brake_pads', sub: null })
    expect(partKind('Диск гальмівний передній')).toEqual({ group: 'brake_disc', sub: null })
    expect(partKind('Свеча зажигания NGK BKR6E')).toEqual({ group: 'plug', sub: 'spark' })
    expect(partKind('Свічка розжарювання')).toEqual({ group: 'plug', sub: 'glow' })
    expect(partKind('Масло моторное Castrol 5W-40 4л')).toEqual({ group: 'oil', sub: null })
    expect(partKind('Акумулятор EXIDE 100Ah')).toEqual({ group: 'battery', sub: null })
  })

  it('an oil filter is a filter, not oil; a word inside another word does not count', () => {
    expect(partKind('Масляний фільтр Knecht')?.group).toBe('filter')
    expect(partKind('Маслознімні ковпачки')).toBeNull()
    expect(partKind('SKF VKBA 3525')).toBeNull()
    expect(partKind('')).toBeNull()
  })

  it('conflict only when both kinds are known and differ', () => {
    expect(namesConflict('Фільтр масляний', 'Колодки гальмівні')).toBe(true)
    expect(namesConflict('Фільтр масляний', 'Фільтр повітряний')).toBe(true)
    expect(namesConflict('Фільтр масляний', 'Фильтр WIX')).toBe(false)
    expect(namesConflict('Фільтр масляний', 'MANN W 712/75')).toBe(false)
    expect(kindsConflict(null, null)).toBe(false)
  })
})

describe('crosses are picked with the part kind in mind', () => {
  const row = (code: string, extra: Record<string, unknown>) => ({ code, code_key: code, brand: 'B', replacement_type: null, ...extra })

  it('our card is an oil filter: crosses of brake pads with the same number are dropped', () => {
    const picked = pickCrossRows([
      row('OC90', { src_name: 'Фільтр масляний Mann W712' }),
      row('GDB1550', { src_name: 'Колодки гальмівні TRW' }),
      row('P9999', { own_name: 'Колодки тормозные задние' }),
      row('WL7131', { own_name: 'Фильтр масляный WIX' }),
    ], ['Фільтр масляний W712 s'])
    expect(picked.map(item => item.code)).toEqual(['OC90', 'WL7131'])
    expect(picked[0].base).toContain('Фільтр масляний Mann W712')
  })

  it('no card of ours and unknown names: nothing is dropped; the same code and brand become one row', () => {
    const picked = pickCrossRows([row('A1', { src_name: 'X 1' }), row('A1', { src_name: 'X 2' }), row('B2', {})], [])
    expect(picked.map(item => item.code)).toEqual(['A1', 'B2'])
    expect(picked[0].base).toEqual(['X 1', 'X 2'])
  })
})
