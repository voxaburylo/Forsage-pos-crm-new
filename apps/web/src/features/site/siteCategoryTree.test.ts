import { describe, expect, it } from 'vitest'
import { buildCategoryTree, categoryPath, filterTree, type CatalogCategory } from './siteCategoryTree'

// 26.11.2026, слово власника: «товари, у них категорії, у категоріях товари — як на великих сайтах; або “усі товари”».
const rows: CatalogCategory[] = [
  { id: 'oils', parent_id: null, name: 'Оливи', ours: 5, supplier: 20 },
  { id: 'motor', parent_id: 'oils', name: 'Моторні оливи', ours: 3, supplier: 10 },
  { id: 'atf', parent_id: 'oils', name: 'Трансмісійні', ours: 0, supplier: 0 },
  { id: 'filters', parent_id: null, name: 'Фільтри', ours: 0, supplier: 4 },
  { id: 'lost', parent_id: 'gone', name: 'Свічки', ours: 1, supplier: 0 },
  { id: 'loopA', parent_id: 'loopB', name: 'Цикл А', ours: 1, supplier: 0 },
  { id: 'loopB', parent_id: 'loopA', name: 'Цикл Б', ours: 1, supplier: 0 },
]

describe('site goods: category tree on the left', () => {
  it('counts include nested categories and only the chosen goods; empty branches are hidden', () => {
    const all = buildCategoryTree(rows, 'all')
    const oils = all.find(node => node.id === 'oils')!
    expect(oils.total).toBe(38)
    expect(oils.children.map(node => node.id)).toEqual(['motor']) // «Трансмісійні» порожні — не видно
    expect(buildCategoryTree(rows, 'ours').find(node => node.id === 'oils')!.total).toBe(8)
    expect(buildCategoryTree(rows, 'ours').some(node => node.id === 'filters')).toBe(false) // наших фільтрів немає
    expect(buildCategoryTree(rows, 'supplier').find(node => node.id === 'filters')!.total).toBe(4)
  })

  it('a category whose parent is gone sits at the top; a loop in the data does not hang', () => {
    const all = buildCategoryTree(rows, 'all')
    expect(all.some(node => node.id === 'lost')).toBe(true)
    expect(JSON.stringify(all)).not.toContain('loopA') // цикл без кореня — нікуди не чіпляється й не вішає екран
  })

  it('breadcrumb path goes from the top down', () => {
    expect(categoryPath(rows, 'motor').map(row => row.name)).toEqual(['Оливи', 'Моторні оливи'])
    expect(categoryPath(rows, 'loopA').length).toBeLessThanOrEqual(2)
  })

  it('finding a category keeps the path to it; case does not matter (letter «s» check: «Свічки»)', () => {
    const all = buildCategoryTree(rows, 'all')
    expect(filterTree(all, 'МОТОР').map(node => [node.id, node.children.map(child => child.id)])).toEqual([['oils', ['motor']]])
    expect(filterTree(all, 'свічк').map(node => node.id)).toEqual(['lost'])
    expect(filterTree(all, '  ')).toHaveLength(all.length)
  })
})
