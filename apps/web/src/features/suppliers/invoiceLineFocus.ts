export type InvoiceRowField = 'name' | 'sku' | 'barcode' | 'qty' | 'purchase' | 'retail'

const fields: Record<InvoiceRowField, string> = {
  name: 'input[placeholder="Назва товару"]',
  sku: 'input[placeholder="Артикул"]',
  barcode: 'input[placeholder="скан / ввід"]',
  qty: 'input[data-invoice-quantity]',
  purchase: 'input[data-invoice-price="purchase"]',
  retail: 'input[data-invoice-price="retail"]',
}

/** Both desktop rows and mobile cards are mounted; focus only the visible copy. */
export function focusInvoiceLine(form: HTMLFormElement | null, rowKey: string, field: InvoiceRowField = 'sku', preferMatch = false): boolean {
  const row = Array.from(form?.querySelectorAll<HTMLElement>('[data-invoice-row]') ?? [])
    .find(element => element.dataset.invoiceRow === rowKey && element.getClientRects().length > 0)
  if (!row) return false
  const target = (preferMatch ? row.querySelector<HTMLSelectElement>('[data-ai-issue] select:not(:disabled)') : null)
    ?? row.querySelector<HTMLInputElement>(fields[field] + ':not(:disabled)')
    ?? row.querySelector<HTMLInputElement>(fields.name + ':not(:disabled)')
  if (!target) return false
  target.scrollIntoView({ block: 'center', inline: 'nearest' })
  target.focus({ preventScroll: true })
  if (target instanceof HTMLInputElement) target.select()
  return true
}
