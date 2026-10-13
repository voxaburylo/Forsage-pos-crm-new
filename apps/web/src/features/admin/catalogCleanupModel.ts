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
}
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
export const cleanupLevelLabels = { exact: 'Точний збіг за ознаками', review: 'Потрібна перевірка', conflict: 'Є суперечності' }
export const canCleanCatalog = (role: unknown) => role === 'owner' || role === 'admin'
const normalized = (value: unknown) => String(value ?? '').normalize('NFKC').toLocaleLowerCase('uk').replace(/\s+/g, ' ').trim()

export function cleanupGroupsPage(scan: CleanupScan, filter: 'all' | CleanupGroup['level'], query: string, requestedPage: number, pageSize = 12) {
  const products = new Map(scan.products.map(product => [product.id, product]))
  const terms = normalized(query).split(' ').filter(Boolean)
  const groups = scan.groups.filter(group => (filter === 'all' || group.level === filter) && terms.every(term =>
    group.product_ids.some(id => {
      const p = products.get(id)
      return p && normalized([p.name, p.brand, p.sku, p.barcode, ...(p.additional_barcodes ?? []), p.unit, p.notes].join(' ')).includes(term)
    })))
  const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 12
  const pages = Math.max(1, Math.ceil(groups.length / size))
  const page = Math.max(0, Math.min(pages - 1, Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 0))
  return { rows: groups.slice(page * size, page * size + size), pages, page, total: groups.length }
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
