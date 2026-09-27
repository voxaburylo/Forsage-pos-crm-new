import type { PaginatedInvoices, SupplyInvoice } from '@/types/supplier'
import { isMissingInvoiceError, type InvoiceDraftRecord } from './invoiceDraftStore'
import { invoiceDraftMatchesSearch } from './invoiceListState'
interface Filters { status?: string; supplier_id?: string; search?: string; exclude_ids?: string[]; page?: number; per_page?: number }
interface LocalInvoices {
  listInvoices(filters: Filters): Promise<unknown>
  getInvoice(id: string): Promise<unknown>
}
function draftRow(record: InvoiceDraftRecord, stored?: SupplyInvoice): SupplyInvoice {
  const raw = record.data
  const savedAt = String(raw.savedAt || stored?.updated_at || '')
  return {
    ...stored,
    id: 'local-draft:' + encodeURIComponent(record.key),
    supplier_id: raw.supplierId || null, invoice_number: raw.invoiceNumber || null, status: 'draft',
    total: raw.items.reduce((sum: number, item: any) => sum + Math.max(0, Number(item?.total) || 0), 0),
    paid_amount: stored?.paid_amount ?? 0, payment_method: stored?.payment_method ?? null,
    notes: raw.notes || null, posted_by: null, posted_at: null,
    created_at: stored?.created_at || savedAt, updated_at: savedAt,
    supplier: stored?.supplier ?? (raw.supplierId ? { id: raw.supplierId, name: 'Постачальник' } : null),
  }
}
export async function listLocalInvoicesWithDrafts(local: LocalInvoices, filters: Filters, records: InvoiceDraftRecord[]): Promise<PaginatedInvoices> {
  if (filters.status && filters.status !== 'draft') return await local.listInvoices(filters) as PaginatedInvoices
  const virtual: SupplyInvoice[] = []
  const overlays = new Map<string, SupplyInvoice>()
  const excluded: string[] = []
  for (const record of records) {
    if (filters.supplier_id && record.data.supplierId !== filters.supplier_id) continue
    const matches = invoiceDraftMatchesSearch(record.data.items, filters.search)
    if (!record.invoiceId) { if (matches) virtual.push(draftRow(record)); continue }
    try {
      const stored = await local.getInvoice(record.invoiceId) as SupplyInvoice
      // Posted/deleted documents must never become a second editable draft.
      if (stored.status === 'draft') {
        if (filters.search?.trim()) {
          // Search the newest local edits, not an older persisted item snapshot.
          excluded.push(stored.id)
          if (matches) virtual.push(draftRow(record, stored))
        } else overlays.set(stored.id, draftRow(record, stored))
      }
    } catch (error) {
      if (!isMissingInvoiceError(error)) throw error
      // Keep unsaved user data recoverable; explicit Cancel can remove this orphan.
      if (matches) virtual.push(draftRow(record))
    }
  }
  if (excluded.length) filters = { ...filters, exclude_ids: excluded }
  const page = Math.max(1, filters.page || 1)
  const perPage = Math.max(1, Math.min(100, filters.per_page || 20))
  const offset = (page - 1) * perPage
  const prefix = virtual.slice(offset, offset + perPage)
  const databaseOffset = Math.max(0, offset - virtual.length)
  const databasePage = Math.floor(databaseOffset / perPage) + 1
  const skip = databaseOffset % perPage
  const first = await local.listInvoices({ ...filters, page: databasePage, per_page: perPage }) as PaginatedInvoices
  const needed = perPage - prefix.length
  let rows = first.data.slice(skip, skip + needed)
  if (rows.length < needed && databaseOffset + rows.length < first.pagination.total) {
    const second = await local.listInvoices({ ...filters, page: databasePage + 1, per_page: perPage }) as PaginatedInvoices
    rows = [...rows, ...second.data].slice(0, needed)
  }
  const total = first.pagination.total + virtual.length
  return { data: [...prefix, ...rows.map(row => overlays.get(row.id) || row)],
    pagination: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) } }
}
