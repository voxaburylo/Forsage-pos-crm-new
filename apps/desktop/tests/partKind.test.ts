import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { dropOtherKinds, namesConflict, partKind } from '../src/repositories/partKind'

// 26.11.2026, слово власника: «крос-номери мають враховувати й запчастину — щоб до фільтрів не підтягувались колодки».
describe('analogs on the till respect the part kind', () => {
  it('brake pads do not come to a filter; an unknown name is kept', () => {
    const found = [
      { name: 'Фільтр масляний Knecht OC 90 s' }, { name: 'Колодки гальмівні передні 0090' },
      { name: 'Фільтр повітряний WIX' }, { name: 'WIX WL7131' }, { name: 'Фильтр Bosch' },
    ]
    expect(dropOtherKinds('Фільтр масляний MANN W 712/75', found).map(item => item.name))
      .toEqual(['Фільтр масляний Knecht OC 90 s', 'WIX WL7131', 'Фильтр Bosch'])
  })

  it('a source with an unknown kind filters nothing', () => {
    const found = [{ name: 'Колодки гальмівні' }, { name: 'Фільтр салону' }]
    expect(dropOtherKinds('SKF VKBA 3525', found)).toHaveLength(2)
    expect(partKind('Свеча зажигания NGK')).toEqual({ group: 'plug', sub: 'spark' })
    expect(namesConflict('Ремень ГРМ', 'Ремінь генератора')).toBe(false)
  })

  it('the rules are the same as on the server', () => {
    const cut = (file: string) => {
      const text = readFileSync(path.resolve(__dirname, file), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10))
      const end = text.indexOf('export const namesConflict')
      return text.slice(0, text.indexOf(String.fromCharCode(10), end))
    }
    expect(cut('../src/repositories/partKind.ts')).toBe(cut('../../../server/src/services/partKind.ts'))
  })
})
