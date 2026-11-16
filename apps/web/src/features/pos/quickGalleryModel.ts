import type { QuickItemConfig } from '@/features/admin/adminApi'

/**
 * Галерея «Швидкий доступ» на касі — один плаский список товарів з фото.
 * Джерела: товари з позначкою «⭐ Швидкий товар», товари з категорій, що були
 * в старій плитці «ЇЖА», і товари за артикулами старих плиток (камера, пакет),
 * щоб після переходу на галерею з каси нічого не зникло.
 */
// Старі плитки лишаються джерелом галереї: їхні категорії й артикули теж показуються.
export const DEFAULT_QUICK_ITEMS: QuickItemConfig[] = [
  {
    sku: 'FOOD', label: 'ЇЖА', emoji: '🍕', price: 0, color: '#7C2D12',
    type: 'food_popup', category_filter: ['Кава та напої', 'Снеки та хотдоги'],
    children: [],
  },
  { sku: 'CAM13',  label: 'КАМЕРА', emoji: '🛞', price: 0,   color: '#065F46', type: 'static', children: [
    { label: 'Р13', sku: 'CAM-R13', price: 0 },
    { label: 'Р14', sku: 'CAM-R14', price: 0 },
  ]},
  { sku: 'PACKET', label: 'ПАКЕТ',     emoji: '🛍', price: 500, color: '#075985', type: 'static', children: [] },
]

export interface QuickGallerySources {
  categoryNames: string[]
  skus: string[]
}

export function quickGallerySources(config: readonly QuickItemConfig[]): QuickGallerySources {
  const categoryNames = new Set<string>()
  const skus = new Set<string>()
  for (const item of config) {
    if (item.type === 'food_popup') {
      for (const name of item.category_filter ?? []) if (name.trim()) categoryNames.add(name.trim())
      continue
    }
    if (item.sku.trim()) skus.add(item.sku.trim())
    for (const child of item.children ?? []) if (child.sku?.trim()) skus.add(child.sku.trim())
  }
  return { categoryNames: [...categoryNames], skus: [...skus] }
}

/** Назви категорій порівнюємо без регістру й зайвих пробілів: «Кава та напої» = «кава  та напої». */
export function categoryKey(name: string): string {
  return String(name ?? '').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('uk')
}

export function matchCategoryIds(categories: ReadonlyArray<{ id: string; name: string }>, names: readonly string[]): string[] {
  const wanted = new Set(names.map(categoryKey))
  return categories.filter(category => wanted.has(categoryKey(category.name))).map(category => category.id)
}

export interface QuickGalleryProduct {
  id: string
  sku: string
  name: string
  retail_price: number
  is_favorite?: boolean | null
  photo_url?: string | null
  category?: { name: string } | null
}

/** Без повторів; спершу товари з фото, далі за категорією й назвою — порядок не стрибає між відкриттями. */
export function mergeQuickGallery<T extends QuickGalleryProduct>(lists: ReadonlyArray<readonly T[]>): T[] {
  const byId = new Map<string, T>()
  for (const list of lists) for (const product of list) if (!byId.has(product.id)) byId.set(product.id, product)
  return [...byId.values()].sort((a, b) =>
    Number(Boolean(b.photo_url)) - Number(Boolean(a.photo_url))
    || (a.category?.name ?? '').localeCompare(b.category?.name ?? '', 'uk')
    || a.name.localeCompare(b.name, 'uk')
    || a.id.localeCompare(b.id))
}

/** Пошук у галереї: за назвою або артикулом, без регістру. */
export function filterQuickGallery<T extends QuickGalleryProduct>(products: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase('uk')
  if (!needle) return [...products]
  return products.filter(product =>
    product.name.toLocaleLowerCase('uk').includes(needle) || product.sku.toLocaleLowerCase('uk').includes(needle))
}
