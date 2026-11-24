import { describe, expect, it } from 'vitest'
import { foldWord, guessCategory, learnCategories, typeWords } from '../supplierCategories.js'

const FILTERS = 'c-filters', BRAKES = 'c-brakes', STEER = 'c-steer', ACC = 'c-acc'
const ours = [
  ...['Фильтр воздушный Ланос', 'Фильтр воздушный Авео', 'Фильтр масляный Амулет', 'Фильтр салона Ланос', 'Фильтр топливный Сенс'].map(name => ({ name, category_id: FILTERS })),
  ...['Колодки тормозные передние Ланос', 'Колодки тормозные задние Авео', 'Колодки тормозные передние Матиз'].map(name => ({ name, category_id: BRAKES })),
  ...['Тяга рулевая Ланос', 'Тяга рулевая Авео'].map(name => ({ name, category_id: STEER })),
  ...['Накладка на педаль', 'Накладка руля', 'Накладка порога'].map(name => ({ name, category_id: ACC })),
  { name: 'Накладка диска сцепления 2101', category_id: 'c-clutch' }, { name: 'Комплект ремкомплект', category_id: null },
]

// 24.11.2026 (власник: «що автоматично не розклалось — залиш без категорії»).
describe('supplier goods into our categories', () => {
  const model = learnCategories(ours)
  it('Ukrainian and Russian spellings of a product type meet', () => {
    expect(foldWord('Фільтр')).toBe(foldWord('Фильтр'))
    expect(typeWords('Фільтр повітряний HYUNDAI')).toEqual(typeWords('Фильтр воздушный Ланос').slice(0, 2).concat(['hyund']))
    expect(typeWords('Колодка гальм. диск. BMW')[1]).toBe(typeWords('Колодки тормозные')[1])
  })
  it('places goods by the type learned from our cards', () => {
    expect(guessCategory(model, 'Фільтр повітряний CITROEN BERLINGO (вир-во DENSO)')).toBe(FILTERS)
    expect(guessCategory(model, 'Фільтр паливний MITSUBISHI ASX')).toBe(FILTERS)
    expect(guessCategory(model, 'Колодка гальм. диск. BMW 3 задн. (вир-во ABS)')).toBe(BRAKES)
    expect(guessCategory(model, 'Тяга рульова OPEL VECTRA C')).toBe(STEER)
  })
  it('leaves without a category when unsure: unknown type, a word spread over categories, too few cards', () => {
    expect(guessCategory(model, 'Підшипник маточини Range Rover')).toBeNull()
    // «Накладка» — 3 з 4 у аксесуарах: для одного слова цього мало, а «накладка диска» є лише раз.
    expect(guessCategory(model, 'Накладка диска зчеплення ЯМЗ 236')).toBeNull()
    expect(guessCategory(model, 'Комплект ГРМ')).toBeNull()
    expect(guessCategory(model, '12345')).toBeNull()
  })
})
