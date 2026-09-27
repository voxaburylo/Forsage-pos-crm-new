import { beforeEach, expect, it } from 'vitest'
import { readInvoiceDraftRecords, removeInvoiceDrafts } from './invoiceDraftStore'
import { listLocalInvoicesWithDrafts } from './localInvoiceList'
const values = new Map<string, string>()
const storage = { get length() { return values.size }, key: (i: number) => [...values.keys()][i] ?? null,
  getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) },
  removeItem: (key: string) => { values.delete(key) }, clear: () => values.clear() } as Storage
const key = (name: string) => 'forsage:supply-invoice:' + name + ':draft:v2'
function save(scope: string, invoiceId?: string, savedAt = '2026-09-15T10:00:00Z') {
  storage.setItem(key(scope), JSON.stringify({ items: [{ qty: 8, total: 800 }], serverInvoiceId: invoiceId, savedAt }))
}
const row = (id: string, status = 'draft') => ({ id, status, total: 800, paid_amount: 0, updated_at: '2026-09-15T09:00:00Z' })
function local(rows: any[]) { return {
  getInvoice: async (id: string) => { const found = rows.find(r => r.id === id); if (!found) throw new Error('Накладну не знайдено'); return found },
  listInvoices: async ({ page = 1, per_page = 20, exclude_ids = [] }: any) => {
    const filtered = rows.filter(row => !exclude_ids.includes(row.id))
    return { data: filtered.slice((page - 1) * per_page, page * per_page),
      pagination: { page, per_page, total: filtered.length, total_pages: Math.ceil(filtered.length / per_page) } }
  },
} }
beforeEach(() => values.clear())
it('lists an AI invoice and its resumed/edit snapshots only once', async () => {
  save('edit-ai-1', 'ai-1'); save('fresh-1', 'ai-1', '2026-09-15T11:00:00Z')
  const records = readInvoiceDraftRecords(storage)
  expect(records).toHaveLength(1)
  expect(records[0].key).toBe(key('fresh-1'))
  const result = await listLocalInvoicesWithDrafts(local([row('ai-1')]), {}, records)
  expect(result.data).toHaveLength(1)
  expect(result.pagination.total).toBe(1)
  expect(result.data[0].id).toContain(encodeURIComponent(key('fresh-1')))
})
it('does not show a posted document again as an editable draft', async () => {
  save('edit-posted-1', 'posted-1')
  const result = await listLocalInvoicesWithDrafts(local([row('posted-1', 'posted')]), {}, readInvoiceDraftRecords(storage))
  expect(result.data.map(r => r.id)).toEqual(['posted-1'])
  expect(result.pagination.total).toBe(1)
})
it('removes every alias after explicit deletion but preserves another document', () => {
  save('edit-one', 'one'); save('fresh-one', 'one'); save('fresh-two', 'two')
  removeInvoiceDrafts(undefined, 'one', storage)
  expect(readInvoiceDraftRecords(storage).map(r => r.invoiceId)).toEqual(['two'])
})
it('recognizes older edit snapshots that did not store serverInvoiceId', () => {
  save('edit-legacy')
  expect(readInvoiceDraftRecords(storage)[0].invoiceId).toBe('legacy')
  removeInvoiceDrafts(key('edit-legacy'), undefined, storage)
  expect(values.size).toBe(0)
})
it('retains an orphan for explicit cancellation instead of losing user rows', async () => {
  save('edit-deleted', 'deleted')
  const result = await listLocalInvoicesWithDrafts(local([]), {}, readInvoiceDraftRecords(storage))
  expect(result.data).toHaveLength(1)
  expect(values.size).toBe(1)
})
it('paginates virtual drafts and saved documents without duplicates or gaps', async () => {
  save('fresh-new')
  const rows = Array.from({ length: 6 }, (_, i) => row('saved-' + i))
  const pages = await Promise.all([1, 2, 3].map(page => listLocalInvoicesWithDrafts(local(rows), { page, per_page: 3 }, readInvoiceDraftRecords(storage))))
  expect(pages.map(p => p.data.length)).toEqual([3, 3, 1])
  const ids = pages.flatMap(p => p.data.map(r => r.id))
  expect(new Set(ids).size).toBe(7)
  expect(ids.slice(1)).toEqual(rows.map(r => r.id))
  expect(pages[0].pagination.total).toBe(7)
})
it('does not interpret a database failure as an invoice deletion', async () => {
  save('edit-1', '1')
  await expect(listLocalInvoicesWithDrafts({ ...local([]), getInvoice: async () => { throw new Error('database is locked') } }, {}, readInvoiceDraftRecords(storage))).rejects.toThrow('database is locked')
})
it('searches the latest draft snapshot without duplicate old persisted rows', async () => {
  storage.setItem(key('edit-one'), JSON.stringify({ serverInvoiceId: 'one', items: [{ product_name: 'Новий фільтр', barcode: '999', total: 100 }] }))
  storage.setItem(key('fresh-two'), JSON.stringify({ items: [{ product_name: 'Ремінь', total: 200 }] }))
  const found = await listLocalInvoicesWithDrafts(local([row('one')]), { search: 'фільтр 999' }, readInvoiceDraftRecords(storage))
  expect(found.pagination.total).toBe(1)
  expect(found.data[0].id).toContain('local-draft:')
  const none = await listLocalInvoicesWithDrafts(local([row('one')]), { search: 'old name' }, readInvoiceDraftRecords(storage))
  expect(none.pagination.total).toBe(0)
})
