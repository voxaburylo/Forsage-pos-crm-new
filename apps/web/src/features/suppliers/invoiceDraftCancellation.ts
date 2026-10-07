import type { SupplyInvoice } from '@/types/supplier'
import { isMissingInvoiceError } from './invoiceDraftStore'

interface DraftApi {
  getInvoice(id: string): Promise<{ data: SupplyInvoice }>
  deleteInvoice(id: string, expectedRevision?: string): Promise<unknown>
}

/** Called only after explicit Cancel in an open draft form.
 * A confirmed absent local document lets us discard its unsaved overlay,
 * not claim a database deletion succeeded. Other lookup/delete failures propagate.
 * Existing legacy drafts require comparison before deleting unseen edits. */
export async function cancelStoredInvoiceDraft(api: DraftApi, id: string, revision: string | undefined, local: boolean): Promise<SupplyInvoice | null> {
  if (local) {
    let current: SupplyInvoice
    try { current = (await api.getInvoice(id)).data }
    catch (error) {
      if (isMissingInvoiceError(error)) return null
      throw error
    }
    if (!revision) return current
  }
  await api.deleteInvoice(id, revision)
  return null
}
