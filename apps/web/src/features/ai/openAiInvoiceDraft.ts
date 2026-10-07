import { desktopBridge } from '@/lib/desktopBridge'
import { aiActionOperationId } from './aiActionOperation'
import type { AiPendingAction } from './aiApi'
import { aiRowsToInvoiceItems } from '@/features/suppliers/aiInvoiceMatching'
import { draftFromServerInvoice, loadSupplyInvoiceDraft, saveSupplyInvoiceDraft, supplyInvoiceDraftKey } from '@/features/suppliers/invoiceFormModel'
import { isMissingInvoiceError } from '@/features/suppliers/invoiceDraftStore'

/** Recognition prepares the ordinary local draft. It never writes cards, payments or stock. */
export async function openAiInvoiceDraft(action: AiPendingAction, scope: string, guard: () => void): Promise<string> {
  guard()
  const bridge = desktopBridge(), supply = bridge?.supply
  if (!supply?.previewInvoiceFromAi) throw new Error('Потрібна оновлена локальна програма')
  const identity = await aiActionOperationId(scope, 'invoice:' + action.id)
  const key = supplyInvoiceDraftKey('ai-' + identity), linkKey = 'forsage:ai-invoice-link:' + identity
  const link = JSON.parse(localStorage.getItem(linkKey) || 'null') as { invoiceId: string; ready: boolean } | null
  const priorDraft = loadSupplyInvoiceDraft(key)
  guard()
  if (priorDraft) return '/suppliers/invoices/new?resume=' + encodeURIComponent(key)
  if (link?.ready) {
    try {
      const invoice = await supply.getInvoice(link.invoiceId)
      guard()
      return '/suppliers/invoices/' + invoice.id
    } catch (error) {
      if (!isMissingInvoiceError(error)) throw error
      throw new Error('Цю чернетку вже закрито. Повторну накладну не створено.')
    }
  }
  const rows = Array.isArray(action.payload.products) ? action.payload.products : []
  const review = await supply.previewInvoiceFromAi({ rows, operation_id: 'ai-action:' + scope + ':' + action.id })
  guard()
  // Pending actions from an older EXE may have committed before their reply was lost.
  if (review[0]?.already_saved && review[0].invoice_id) {
    const invoice = await supply.getInvoice(review[0].invoice_id)
    guard()
    if (invoice.status !== 'draft') return '/suppliers/invoices/' + invoice.id
    const draft = draftFromServerInvoice(invoice)
    if (!draft) throw new Error('Збережену накладну відкрийте у «Поступленні товарів»')
    saveSupplyInvoiceDraft(key, draft)
    return '/suppliers/invoices/new?resume=' + encodeURIComponent(key)
  }
  const [categories, settings, suppliers] = await Promise.all([
    bridge?.catalog.listCategories?.() ?? [],
    bridge?.catalog.getSettings?.() ?? {},
    action.payload.supplier_name && supply.listSuppliers ? supply.listSuppliers({ search: action.payload.supplier_name, per_page: 200 }) : null,
  ])
  guard()
  const normalize = (raw: unknown) => String(raw ?? '').normalize('NFKC').trim().toLocaleLowerCase('uk-UA')
  const supplierMatches = (suppliers?.data ?? []).filter((supplier: {name:string}) => normalize(supplier.name) === normalize(action.payload.supplier_name))
  const invoiceId = link?.invoiceId || crypto.randomUUID()
  const items = aiRowsToInvoiceItems(rows, review, categories, settings)
  // Reserve identity before the snapshot, but do not report completion until both writes succeed.
  localStorage.setItem(linkKey, JSON.stringify({ invoiceId, ready: false }))
  saveSupplyInvoiceDraft(key, {
    supplierId: action.payload.supplier_id || (supplierMatches.length === 1 ? supplierMatches[0].id : ''),
    invoiceNumber: action.payload.invoice_number || '',
    notes: action.payload.notes || 'Підготовлено з розбору ШІ. Перевірте підсвічені рядки.',
    items, paidAmount: '', cashboxPaidAmount: '', payFullNow: false, paymentMethod: 'cash', fundSource: 'cashbox',
    commitInvoiceId: invoiceId,
  })
  localStorage.setItem(linkKey, JSON.stringify({ invoiceId, ready: true }))
  return '/suppliers/invoices/new?resume=' + encodeURIComponent(key)
}
