export interface CatalogIssue {
  id: string; product_id: string; fingerprint: string; name: string; sku: string; kind: string; reason: string
  before?: Record<string, any>; changes: Record<string, any>; qty_on_hand?: number
  primary_id?: string; primary_fingerprint?: string; primary_name?: string; primary_sku?: string; blocked?: string | null
}
export function selectableAgentIssue(row: CatalogIssue) { return !row.blocked && (!!row.primary_id || Object.keys(row.changes).length > 0) }
export function catalogAgentPayload(rows: CatalogIssue[]) {
  const grouped = new Map<string, any>()
  for (const row of rows) {
    if (!selectableAgentIssue(row)) throw new Error('У списку є заблокована або порожня пропозиція')
    const action = grouped.get(row.product_id)
    if (action && (action.primary_id || row.primary_id || action.fingerprint !== row.fingerprint)) throw new Error('Видалення дубля та редагування цієї картки потрібно виконувати окремо')
    if (action) {
      for (const [key, value] of Object.entries(row.changes)) {
        if (key in action.changes && action.changes[key] !== value) throw new Error('Є різні пропозиції для одного поля. Виберіть одну.')
        action.changes[key] = value
      }
    } else grouped.set(row.product_id, { product_id: row.product_id, fingerprint: row.fingerprint, changes: { ...row.changes }, ...(row.primary_id ? { primary_id: row.primary_id, primary_fingerprint: row.primary_fingerprint } : {}) })
  }
  const result = [...grouped.values()]
  if (!result.length || result.length > 100) throw new Error('За один раз можна підтвердити від 1 до 100 товарів')
  if (result.some(row => row.primary_id && grouped.has(row.primary_id))) throw new Error('Основну картку дубля не можна змінювати в цьому ж пакеті')
  return result
}

/**
 * Позначені зауваження → що з ними можна зробити.
 * Галочку можна поставити на будь-якому рядку: рядки з готовою пропозицією агента
 * застосовуються кнопкою «Застосувати пропозиції», а всі позначені товари можна
 * змінити масово (категорія, ціни, активність).
 */
export function agentSelection(issues: readonly CatalogIssue[], selected: ReadonlySet<string>) {
  const rows = issues.filter(row => selected.has(row.id))
  return {
    rows,
    proposals: rows.filter(selectableAgentIssue),
    productIds: [...new Set(rows.map(row => row.product_id))],
  }
}

/** Пропозиції по 100 товарів — стільки приймає один запис агента. Дубль і правка однієї картки не потрапляють в одну частину. */
export function agentPayloadChunks(rows: CatalogIssue[], size = 100) {
  const chunks: CatalogIssue[][] = []
  let current: CatalogIssue[] = []
  let products = new Set<string>()
  for (const row of rows) {
    const touches = [row.product_id, ...(row.primary_id ? [row.primary_id] : [])]
    const conflicts = current.some(other => other.product_id === row.product_id ? (other.primary_id || row.primary_id) : touches.includes(other.product_id) || (other.primary_id !== undefined && other.primary_id === row.product_id))
    if (current.length && (conflicts || (!products.has(row.product_id) && products.size >= size))) {
      chunks.push(current); current = []; products = new Set()
    }
    current.push(row); products.add(row.product_id)
  }
  if (current.length) chunks.push(current)
  return chunks.map(catalogAgentPayload)
}

export function retainAgentReview(products: Array<{id: string; fingerprint: string}>, issues: CatalogIssue[], reviewed: Record<string, string>) {
  const fresh = new Map(products.map(p => [p.id, p.fingerprint]))
  return {
    issues: issues.filter(row => row.kind === 'ai' && fresh.get(row.product_id) === row.fingerprint),
    reviewed: Object.fromEntries(Object.entries(reviewed).filter(([id, fingerprint]) => fresh.get(id) === fingerprint)),
  }
}
