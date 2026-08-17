export interface InvoiceQuantityLine {
  client_key: string
  qty: number
  purchase_price: number
  total: number
}

export function parseManualInvoiceQuantity(value: string | number): number {
  const parsed = Number(String(value).trim().replace(',', '.'))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

export function applyManualInvoiceQuantities<T extends InvoiceQuantityLine>(
  items: T[],
  overrides: ReadonlyMap<string, number>,
): T[] {
  return items.map((item) => {
    if (!overrides.has(item.client_key)) return item
    const qty = overrides.get(item.client_key)!
    if (qty === item.qty) return item
    return {
      ...item,
      qty,
      total: Math.round(qty * item.purchase_price),
    }
  })
}
