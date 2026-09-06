import { describe, expect, it } from 'vitest'
import { inventoryPage, INVENTORY_PAGE_SIZE } from './inventoryPaging'

describe('inventory rendering pages', () => {
  it('covers every item once while rendering at most 150 rows', () => {
    const total = 10005
    const indexes: number[] = []
    for (let page = 0; page < inventoryPage(total, 0).pages; page++) {
      const range = inventoryPage(total, page)
      expect(range.end - range.start).toBeLessThanOrEqual(INVENTORY_PAGE_SIZE)
      for (let i = range.start; i < range.end; i++) indexes.push(i)
    }
    expect(indexes).toEqual(Array.from({ length: total }, (_, i) => i))
  })
  it('clamps a page after removing rows and handles an empty document', () => {
    expect(inventoryPage(151, 9)).toMatchObject({ page: 1, start: 150, end: 151 })
    expect(inventoryPage(0, 9)).toMatchObject({ page: 0, start: 0, end: 0 })
  })
})
