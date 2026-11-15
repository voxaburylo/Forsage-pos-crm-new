/** Read-only scan and explicitly reviewed writes. A matching group is NOT a merge authorization. */
export interface CleanupProduct {
  id: string; name: string; sku: string; brand?: string | null; brand_id?: string | null
  barcode?: string | null; additional_barcodes?: string[]; unit: string; qty_on_hand: number
  purchase_price?: number; retail_price?: number; created_at?: string; category_id?: string | null
  photo_url?: string | null; notes?: string | null; fingerprint: string
}
export interface CleanupGroup {
  id: string; level: 'exact' | 'review' | 'conflict'; product_ids: string[]
  reasons: string[]; conflicts: string[]; suggested_target_id?: string
  /** 0–100 від локального пошуку: спільний штрихкод або номер виробника — вище. Старі збірки не надсилають. */
  confidence?: number
}
/** `merge` — усе, що можна об'єднувати (без суперечностей); це типовий вигляд списку. */
export type CleanupFilter = 'merge' | 'all' | CleanupGroup['level']
export interface CleanupSkuSuggestion { product_id: string; sku: string; evidence: string; preview_fingerprint: string; blocked?: string | null }
export interface CleanupScan {
  products: CleanupProduct[]; groups: CleanupGroup[]; sku_suggestions: CleanupSkuSuggestion[]
  total?: number; warnings?: string[]; stats?: Record<string, number>
  capability?: { available: boolean; reason?: string }
}
export interface CleanupPreview {
  fingerprint: string; target_id: string; source_ids: string[]; products: CleanupProduct[]
  history_counts: Record<string, unknown>; blockers: string[]; warnings: string[]
  quantity_before: number[]; quantity_after: number; barcodes: string[]
  photos: Array<{ product_id: string; photo_url: string }>; can_apply: boolean; stock_review: 'pending' | 'checked'
}
export interface CleanupMergeInput {
  target_id: string; source_ids: string[]; stock_review: 'pending' | 'checked'
  preview_fingerprint: string; reason: string
}
export interface CleanupOperation<T extends object> { key: string; input: T & { operation_id: string } }
export const cleanupLevelLabels = { exact: 'Імовірний дубль', review: 'Схожі — перевірте', conflict: 'Є суперечності' }
export const cleanupFilterLabels: Record<CleanupFilter, string> = {
  merge: 'Можна об’єднувати', exact: 'Лише ймовірні дублі', review: 'Лише схожі', conflict: 'Суперечності', all: 'Усі групи',
}
export const canCleanCatalog = (role: unknown) => role === 'owner' || role === 'admin'
const normalized = (value: unknown) => String(value ?? '').normalize('NFKC').toLocaleLowerCase('uk').replace(/\s+/g, ' ').trim()
const searchable = (p: CleanupProduct) => normalized([p.name, p.brand, p.sku, p.barcode, ...(p.additional_barcodes ?? []), p.unit, p.notes].join(' '))
const LEVEL_ORDER: Record<CleanupGroup['level'], number> = { exact: 0, review: 1, conflict: 2 }

/**
 * Список для роботи, а не звіт: спершу ймовірні дублі, серед них — ті, де товар є на полиці,
 * далі за впевненістю. Суперечності в типовому вигляді приховано: це не кандидати на об'єднання.
 */
export function cleanupGroupsPage(scan: CleanupScan, filter: CleanupFilter, query: string, requestedPage: number, pageSize = 12) {
  const products = new Map(scan.products.map(product => [product.id, product]))
  const terms = normalized(query).split(' ').filter(Boolean)
  const visible = (group: CleanupGroup) => filter === 'all' || (filter === 'merge' ? group.level !== 'conflict' : group.level === filter)
  const inStock = (group: CleanupGroup) => group.product_ids.some(id => (products.get(id)?.qty_on_hand ?? 0) > 0) ? 0 : 1
  const groups = scan.groups.map((group, index) => ({ group, index })).filter(({ group }) => visible(group) && terms.every(term =>
    group.product_ids.some(id => { const p = products.get(id); return p && searchable(p).includes(term) })))
    .sort((a, b) => LEVEL_ORDER[a.group.level] - LEVEL_ORDER[b.group.level] || inStock(a.group) - inStock(b.group)
      || (b.group.confidence ?? 0) - (a.group.confidence ?? 0) || a.index - b.index)
    .map(({ group }) => group)
  const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 12
  const pages = Math.max(1, Math.ceil(groups.length / size))
  const page = Math.max(0, Math.min(pages - 1, Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 0))
  return { rows: groups.slice(page * size, page * size + size), pages, page, total: groups.length }
}

/** Кількість груп за рівнями — щоб було видно обсяг роботи, а не одне велике число. */
export function cleanupLevelCounts(scan: CleanupScan): Record<CleanupGroup['level'], number> {
  const counts = { exact: 0, review: 0, conflict: 0 }
  for (const group of scan.groups) counts[group.level]++
  return counts
}

export const MANUAL_GROUP_ID = 'manual-selection'
/**
 * Ручний вибір: власник сам знає, що дві картки — один товар, хоча пошук їх не звів.
 * Це лише перелік карток; запис, як і для знайдених груп, іде через свіжу перевірку та підтвердження.
 */
export function manualCleanupGroup(productIds: string[]): CleanupGroup {
  return { id: MANUAL_GROUP_ID, level: 'review', product_ids: [...new Set(productIds)], reasons: ['Картки вибрано вручну'], conflicts: [] }
}

/** Пошук будь-якої картки каталогу за назвою, артикулом або штрихкодом для ручного об'єднання. */
export function searchCleanupProducts(scan: CleanupScan, query: string, excludeIds: string[] = [], limit = 20): CleanupProduct[] {
  const terms = normalized(query).split(' ').filter(Boolean)
  if (!terms.length || terms.join('').length < 2) return []
  const excluded = new Set(excludeIds), found: CleanupProduct[] = []
  for (const product of scan.products) {
    if (excluded.has(product.id)) continue
    const haystack = searchable(product)
    if (terms.every(term => haystack.includes(term))) { found.push(product); if (found.length >= limit) break }
  }
  return found
}

/**
 * Після підтвердженого об'єднання прибирає з екрана об'єднані картки, не запускаючи нову
 * перевірку всього каталогу: інакше після кожної пари доводилося чекати й шукати місце в списку.
 * Групи з основною карткою теж зникають — її дані змінилися, наступна перевірка зведе їх наново.
 */
export function cleanupScanAfterMerge(scan: CleanupScan, targetId: string, sourceIds: string[], quantityAfter: number): CleanupScan {
  const merged = new Set(sourceIds), touched = new Set([targetId, ...sourceIds])
  return {
    ...scan,
    products: scan.products.filter(product => !merged.has(product.id)).map(product => product.id === targetId ? { ...product, qty_on_hand: quantityAfter } : product),
    groups: scan.groups.filter(group => !group.product_ids.some(id => touched.has(id))),
    sku_suggestions: scan.sku_suggestions.filter(row => !touched.has(row.product_id)),
    total: scan.total === undefined ? undefined : Math.max(0, scan.total - sourceIds.length),
  }
}

/** Причина потрібна журналу операцій; типовий текст не змушує власника щоразу її вигадувати. */
export function defaultCleanupReason(group: CleanupGroup): string {
  return group.id === MANUAL_GROUP_ID ? 'Той самий товар: картки вибрано вручну' : 'Той самий товар: ' + (group.reasons[0] ?? 'підтверджено власником')
}

export function cleanupSelectionBlockers(scan: CleanupScan, group: CleanupGroup, targetId: string, sourceIds: string[]) {
  const blockers = [...group.conflicts]
  if (group.level === 'conflict' && !blockers.length) blockers.push('У цій групі є суперечності. Спочатку перевірте картки.')
  if (!targetId) blockers.push('Оберіть основну картку.')
  if (!sourceIds.length) blockers.push('Позначте картки, які потрібно об’єднати з основною.')
  if (sourceIds.length > 20) blockers.push('За один раз можна об’єднати не більше 20 карток з основною.')
  const ids = [targetId, ...sourceIds].filter(Boolean)
  if (new Set(ids).size !== ids.length) blockers.push('Основна картка не може бути джерелом об’єднання; повтори заборонено.')
  if (ids.some(id => !group.product_ids.includes(id) || !scan.products.some(p => p.id === id))) blockers.push('Склад групи змінився або картку не завантажено. Оновіть перевірку.')
  if (ids.some(id => { const product = scan.products.find(p => p.id === id); return product && (!Number.isFinite(product.qty_on_hand) || product.qty_on_hand < 0) })) blockers.push('Некоректні або від’ємні залишки потрібно звірити окремою ревізією.')
  return [...new Set(blockers)]
}

export function cleanupApplyInput(preview: CleanupPreview, targetId: string, sourceIds: string[], reason: string): CleanupMergeInput {
  const sameSources = preview.source_ids.length === sourceIds.length && [...preview.source_ids].sort().every((id, index) => id === [...sourceIds].sort()[index])
  if (preview.target_id !== targetId || !sameSources || !preview.fingerprint) throw new Error('Вибір змінився після перевірки. Перевірте об’єднання ще раз.')
  if (!preview.can_apply || preview.blockers.length) throw new Error(preview.blockers.join(' · ') || 'Це об’єднання недоступне.')
  if (!reason.trim()) throw new Error('Вкажіть причину підтвердженого об’єднання.')
  if (!sourceIds.length || sourceIds.length > 20 || new Set([targetId, ...sourceIds]).size !== sourceIds.length + 1) throw new Error('Некоректний список карток для об’єднання.')
  return { target_id: targetId, source_ids: [...sourceIds], preview_fingerprint: preview.fingerprint, stock_review: preview.stock_review, reason: reason.trim() }
}

export function retainCleanupOperation<T extends object>(pending: CleanupOperation<T> | null, input: T, makeId = () => crypto.randomUUID()): CleanupOperation<T> {
  const key = JSON.stringify(input)
  return pending?.key === key ? pending : { key, input: { ...input, operation_id: makeId() } }
}

export function cleanupSkuInput(scan: CleanupScan, suggestion: CleanupSkuSuggestion) {
  if (suggestion.blocked) throw new Error(suggestion.blocked)
  const product = scan.products.find(p => p.id === suggestion.product_id)
  if (!product || !suggestion.preview_fingerprint) throw new Error('Картку не завантажено. Оновіть перевірку.')
  if (product.sku?.trim() && !/^AUTO[-_]/i.test(product.sku)) throw new Error('Картка вже має ручний артикул. Автоматична заміна недоступна.')
  if (!suggestion.sku.trim() || !suggestion.evidence.trim()) throw new Error('Немає артикула або доказу з назви.')
  return { product_id: product.id, sku: suggestion.sku.trim(), preview_fingerprint: suggestion.preview_fingerprint, reason: suggestion.evidence.trim() }
}
