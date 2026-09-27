// Browser drafts are editing snapshots, not additional warehouse documents.
export const INVOICE_DRAFT_PREFIX = 'forsage:supply-invoice:'
export const INVOICE_DRAFT_SUFFIX = ':draft:v2'
export interface InvoiceDraftRecord { key: string; invoiceId: string | null; data: Record<string, any> }
export function invoiceIdForDraft(key: string, data: Record<string, any>): string | null {
  if (typeof data.serverInvoiceId === 'string' && data.serverInvoiceId) return data.serverInvoiceId
  const prefix = INVOICE_DRAFT_PREFIX + 'edit-'
  return key.startsWith(prefix) && key.endsWith(INVOICE_DRAFT_SUFFIX)
    ? key.slice(prefix.length, -INVOICE_DRAFT_SUFFIX.length) || null : null
}
export function readInvoiceDraftRecords(storage: Storage = localStorage): InvoiceDraftRecord[] {
  const records = new Map<string, InvoiceDraftRecord>()
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i) ?? ''
    if (!key.startsWith(INVOICE_DRAFT_PREFIX) || !key.endsWith(INVOICE_DRAFT_SUFFIX)) continue
    try {
      const data = JSON.parse(storage.getItem(key) || '')
      if (!data || !Array.isArray(data.items)) continue
      const invoiceId = invoiceIdForDraft(key, data)
      const identity = invoiceId || key
      const previous = records.get(identity)
      if (!previous || (Date.parse(data.savedAt) || 0) >= (Date.parse(previous.data.savedAt) || 0)) {
        records.set(identity, { key, invoiceId, data })
      }
    } catch { /* A malformed draft must not block the document list. */ }
  }
  return [...records.values()].sort((a, b) => (Date.parse(b.data.savedAt) || 0) - (Date.parse(a.data.savedAt) || 0))
}
export function removeInvoiceDrafts(key?: string, invoiceId?: string | null, storage: Storage = localStorage) {
  let targetId = invoiceId || null
  if (!targetId && key) {
    try { targetId = invoiceIdForDraft(key, JSON.parse(storage.getItem(key) || '{}')) } catch { /* remove this key only */ }
  }
  const keys: string[] = []
  for (let i = 0; i < storage.length; i++) keys.push(storage.key(i) || '')
  for (const candidate of keys) {
    if (candidate === key) { storage.removeItem(candidate); continue }
    if (!targetId || !candidate.startsWith(INVOICE_DRAFT_PREFIX) || !candidate.endsWith(INVOICE_DRAFT_SUFFIX)) continue
    try {
      if (invoiceIdForDraft(candidate, JSON.parse(storage.getItem(candidate) || '{}')) === targetId) storage.removeItem(candidate)
    } catch { /* Do not remove unrelated or malformed data. */ }
  }
}
export function isMissingInvoiceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /Накладну не знайдено|INVOICE_NOT_FOUND/.test(message)
}
