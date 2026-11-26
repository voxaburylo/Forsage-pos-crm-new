/**
 * 26.11.2026, слово власника: «товари, у них категорії, у категоріях товари — як на великих сайтах; або “усі товари” —
 * тоді все підряд без категорій». Дерево категорій для лівої колонки «Сайт → Товари»: кількість товарів рахується
 * разом із вкладеними категоріями й лише тих товарів, що вибрані («Усі», «Наші», «Від постачальників»).
 */
export interface CatalogCategory { id: string; parent_id: string | null; name: string; ours: number; supplier: number }
export interface CatalogCategoryTree { categories: CatalogCategory[]; none: { ours: number; supplier: number }; suppliers?: Array<{ id: string; name: string }> }
export type CatalogSource = 'all' | 'ours' | 'supplier'
export interface CategoryNode { id: string; name: string; total: number; children: CategoryNode[] }

export const countFor = (row: { ours: number; supplier: number }, source: CatalogSource) =>
  source === 'ours' ? row.ours : source === 'supplier' ? row.supplier : row.ours + row.supplier

/** Дерево з кількістю «разом із вкладеними». Порожні гілки (0 товарів) ховаються; категорія без батька в списку — у корені. */
export function buildCategoryTree(rows: readonly CatalogCategory[], source: CatalogSource): CategoryNode[] {
  const ids = new Set(rows.map(row => row.id))
  const kids = new Map<string | null, CatalogCategory[]>()
  for (const row of rows) {
    const parent = row.parent_id && ids.has(row.parent_id) && row.parent_id !== row.id ? row.parent_id : null
    kids.set(parent, [...(kids.get(parent) ?? []), row])
  }
  const seen = new Set<string>()
  const build = (parent: string | null): CategoryNode[] => (kids.get(parent) ?? []).flatMap(row => {
    if (seen.has(row.id)) return [] // цикл у даних — не зациклюємось
    seen.add(row.id)
    const children = build(row.id)
    const total = countFor(row, source) + children.reduce((sum, child) => sum + child.total, 0)
    return total > 0 ? [{ id: row.id, name: row.name, total, children }] : []
  })
  return build(null) // порядок — як у програмі (сервер віддає за sort_order і назвою)
}

/** Шлях до категорії для рядка «Усі товари › Оливи › Моторні». */
export function categoryPath(rows: readonly CatalogCategory[], id: string): CatalogCategory[] {
  const byId = new Map(rows.map(row => [row.id, row]))
  const path: CatalogCategory[] = []
  let current = byId.get(id)
  while (current && !path.includes(current)) { path.unshift(current); current = current.parent_id ? byId.get(current.parent_id) : undefined }
  return path
}

/** Пошук категорії за словом: показує знайдені й шлях до них. */
export function filterTree(nodes: readonly CategoryNode[], text: string): CategoryNode[] {
  const needle = text.trim().toLocaleLowerCase('uk')
  if (!needle) return [...nodes]
  return nodes.flatMap(node => {
    if (node.name.toLocaleLowerCase('uk').includes(needle)) return [node]
    const children = filterTree(node.children, needle)
    return children.length ? [{ ...node, children }] : []
  })
}
