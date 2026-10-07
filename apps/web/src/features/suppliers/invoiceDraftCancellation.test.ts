import { beforeEach, it, expect, vi } from 'vitest'
import { cancelStoredInvoiceDraft } from './invoiceDraftCancellation'
const api = { getInvoice: vi.fn(), deleteInvoice: vi.fn() }
const invoice = { id: 'one', edit_revision: 'current' }
beforeEach(() => { vi.resetAllMocks(); api.getInvoice.mockResolvedValue({ data: invoice }); api.deleteInvoice.mockResolvedValue(undefined) })
it.each([undefined, 'old'])('allows explicit discard of an orphan local overlay with revision %s without claiming database deletion', async revision => {
  api.getInvoice.mockRejectedValue(new Error('Накладну не знайдено'))
  expect(await cancelStoredInvoiceDraft(api, 'one', revision, true)).toBeNull()
  expect(api.deleteInvoice).not.toHaveBeenCalled()
})
it('keeps an existing legacy draft for comparison instead of deleting unseen changes', async () => {
  expect(await cancelStoredInvoiceDraft(api, 'one', undefined, true)).toBe(invoice)
  expect(api.deleteInvoice).not.toHaveBeenCalled()
})
it('passes the original revision, not the latest fetched revision, to deletion', async () => {
  expect(await cancelStoredInvoiceDraft(api, 'one', 'old', true)).toBeNull()
  expect(api.deleteInvoice).toHaveBeenCalledWith('one', 'old')
})
it('does not mistake a disconnected lookup for an absent invoice', async () => {
  api.getInvoice.mockRejectedValue(new Error('Зв’язок перервано'))
  await expect(cancelStoredInvoiceDraft(api, 'one', 'old', true)).rejects.toThrow('Зв’язок перервано')
  expect(api.deleteInvoice).not.toHaveBeenCalled()
})
it.each(['Накладну не знайдено', 'DOCUMENT_CONFLICT'])('preserves edits after deletion error %s', async message => {
  api.deleteInvoice.mockRejectedValue(new Error(message))
  await expect(cancelStoredInvoiceDraft(api, 'one', 'old', true)).rejects.toThrow(message)
})
it('does not infer orphan state in the remote read-only path', async () => {
  api.deleteInvoice.mockRejectedValue(new Error('Накладну не знайдено'))
  await expect(cancelStoredInvoiceDraft(api, 'one', undefined, false)).rejects.toThrow('Накладну не знайдено')
  expect(api.getInvoice).not.toHaveBeenCalled()
})
