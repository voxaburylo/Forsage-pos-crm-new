import { describe, expect, it } from 'vitest'
import { tillCategoryToCreate } from './tillCategoryModel'

// 27.11.2026, власник: «якщо в нас такої категорії немає, то він її створює» — створює каса, і без дублів.
const existing = [{ id: 'c1', name: 'Кузовні  деталі' }, { id: 'c2', name: 'Свічки' }]

describe('till creates a category asked by the site assistant', () => {
  it('a new name is accepted as is; an existing one (case and spaces aside) is returned instead of a duplicate (letter «s» check in data)', () => {
    expect(tillCategoryToCreate({ name: '  Системи   кондиціонування ' }, existing)).toEqual({ name: 'Системи кондиціонування', existing: null })
    expect(tillCategoryToCreate({ name: 'кузовні деталі' }, existing).existing).toEqual({ id: 'c1', name: 'Кузовні  деталі' })
    expect(tillCategoryToCreate({ name: 'Свічки' }, [...existing, { id: 's', name: 'Spark plugs s' }]).existing?.id).toBe('c2')
  })
  it('brand-like, numeric, too short or too long names are refused', () => {
    for (const name of ['BOSCH', 'Шини R16', 'Аб', 'Дуже'.repeat(20), '']) expect(() => tillCategoryToCreate({ name }, existing)).toThrow()
    expect(() => tillCategoryToCreate(null, existing)).toThrow()
  })
})
