import { pool } from '../db/pg.js'

/**
 * 26.11.2026, слово власника: «чому не можна просто: товари, у них категорії, у категоріях товари — як на великих
 * сайтах, для зручного пошуку й редагування; або вибираємо “усі товари” — тоді показується все підряд без категорій».
 * Категорії — ті самі, що в програмі (categories). Товар постачальника лежить у категорії, якщо програма чи власник
 * розклали його (supplier_offers.category_id); решта — «Без категорії».
 */
export type CatalogCategory = { id: string; parent_id: string | null; name: string; ours: number; supplier: number }
export type CatalogSupplier = { id: string; name: string }
export type CatalogCategoryTree = { categories: CatalogCategory[]; none: { ours: number; supplier: number }; suppliers?: CatalogSupplier[] }

/** Сама категорія і всі вкладені в неї (вибрав «Оливи» — бачиш і «Моторні», і «Трансмісійні»). Цикли в даних не зациклюють. */
export function categorySubtree(rows: ReadonlyArray<{ id: string; parent_id: string | null }>, root: string): string[] {
  const children = new Map<string, string[]>()
  for (const row of rows) if (row.parent_id) children.set(row.parent_id, [...(children.get(row.parent_id) ?? []), row.id])
  const seen = new Set<string>([root])
  const queue = [root]
  while (queue.length) for (const child of children.get(queue.shift()!) ?? []) if (!seen.has(child)) { seen.add(child); queue.push(child) }
  return [...seen]
}

export async function categoryRows(tenantId: string): Promise<Array<{ id: string; parent_id: string | null; name: string }>> {
  const { rows } = await pool.query('SELECT id::text AS id, parent_id::text AS parent_id, name FROM categories WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY sort_order, name', [tenantId])
  return rows.map((row: any) => ({ id: String(row.id), parent_id: row.parent_id ? String(row.parent_id) : null, name: String(row.name) }))
}

// Підрахунок товарів постачальників по категоріях іде по ~900 тис. рядків — тримаємо 5 хв у памʼяті сервера.
const COUNTS_TTL_MS = 5 * 60_000
const offerCounts = new Map<string, { at: number; counts: Map<string | null, number> }>()

async function supplierCounts(tenantId: string): Promise<Map<string | null, number>> {
  const cached = offerCounts.get(tenantId)
  if (cached && Date.now() - cached.at < COUNTS_TTL_MS) return cached.counts
  const { rows } = await pool.query('SELECT category_id::text AS id, count(*)::int AS n FROM supplier_offers WHERE tenant_id = $1 GROUP BY category_id', [tenantId])
  const counts = new Map<string | null, number>(rows.map((row: any) => [row.id ? String(row.id) : null, Number(row.n) || 0]))
  offerCounts.set(tenantId, { at: Date.now(), counts })
  return counts
}

/** Дерево категорій із кількістю товарів у кожній (своїх — без вкладених; разом із вкладеними рахує екран). */
export async function listCatalogCategories(tenantId: string): Promise<CatalogCategoryTree> {
  const [categories, ours, supplier, suppliers] = await Promise.all([
    categoryRows(tenantId),
    pool.query('SELECT category_id::text AS id, count(*)::int AS n FROM products WHERE tenant_id = $1 AND deleted_at IS NULL GROUP BY category_id', [tenantId])
      .then(result => new Map<string | null, number>(result.rows.map((row: any) => [row.id ? String(row.id) : null, Number(row.n) || 0]))),
    supplierCounts(tenantId),
    // Постачальники за API (Омега, GPL) — для вибору «чиї товари».
    pool.query('SELECT id::text AS id, name FROM supplier_api_connections WHERE tenant_id = $1 ORDER BY created_at', [tenantId])
      .then(result => result.rows.map((row: any) => ({ id: String(row.id), name: String(row.name) })), () => [] as CatalogSupplier[]),
  ])
  const known = new Set(categories.map(row => row.id))
  // Товар із категорією, якої вже немає (видалена), — теж «без категорії».
  const orphan = (counts: Map<string | null, number>) => [...counts].reduce((sum, [id, n]) => id && !known.has(id) ? sum + n : sum, 0)
  return {
    categories: categories.map(row => ({ ...row, ours: ours.get(row.id) ?? 0, supplier: supplier.get(row.id) ?? 0 })),
    none: { ours: (ours.get(null) ?? 0) + orphan(ours), supplier: (supplier.get(null) ?? 0) + orphan(supplier) },
    suppliers,
  }
}
