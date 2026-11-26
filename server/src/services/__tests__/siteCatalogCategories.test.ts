import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
import { categorySubtree, listCatalogCategories } from '../siteCatalogCategories.js'

// 26.11.2026, слово власника: «товари, у них категорії, у категоріях товари — як на великих сайтах».
describe('site goods: category tree with counts', () => {
  beforeEach(() => query.mockReset())

  it('a category takes in all nested ones; a loop in the data does not hang', () => {
    const rows = [{ id: 'a', parent_id: null }, { id: 'b', parent_id: 'a' }, { id: 'c', parent_id: 'b' }, { id: 'x', parent_id: null }, { id: 'l1', parent_id: 'l2' }, { id: 'l2', parent_id: 'l1' }]
    expect(categorySubtree(rows, 'a').sort()).toEqual(['a', 'b', 'c'])
    expect(categorySubtree(rows, 'l1').sort()).toEqual(['l1', 'l2'])
  })

  it('counts ours and supplier goods per category; goods in a deleted category count as «no category»; supplier counts are cached', async () => {
    query.mockImplementation(async (sql: string = '') => {
      if (sql.startsWith('SELECT id::text AS id, parent_id')) return { rows: [{ id: 'oils', parent_id: null, name: 'Оливи' }, { id: 'sparks', parent_id: null, name: 'Свічки' }] }
      if (sql.includes('FROM products')) return { rows: [{ id: 'oils', n: 4 }, { id: null, n: 2 }, { id: 'deleted', n: 1 }] }
      return { rows: [{ id: 'oils', n: 30 }, { id: null, n: 100 }] }
    })
    const out = await listCatalogCategories('tenant-a')
    expect(out.categories).toEqual([{ id: 'oils', parent_id: null, name: 'Оливи', ours: 4, supplier: 30 }, { id: 'sparks', parent_id: null, name: 'Свічки', ours: 0, supplier: 0 }])
    expect(out.none).toEqual({ ours: 3, supplier: 100 })
    await listCatalogCategories('tenant-a')
    expect(query.mock.calls.filter(call => String(call[0]).includes('FROM supplier_offers'))).toHaveLength(1)
  })
})
