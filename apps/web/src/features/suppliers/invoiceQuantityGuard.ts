export interface InvoiceQuantityLine {
  client_key: string
  qty: number
  purchase_price: number
  total: number
}

export function nextInvoiceItems<T>(current: T[], update: T[] | ((items: T[]) => T[])): T[] {
  return typeof update === 'function' ? update(current) : update
}

/** Freeze the visible quantities before asynchronous product lookups begin. */
export function captureInvoiceQuantities<T extends InvoiceQuantityLine>(
  items: T[],
  inputs: ReadonlyArray<{ client_key: string; value: string }>,
): T[] {
  const values = new Map(inputs.map(input => [input.client_key, input.value]))
  return items.map((item, index) => {
    const raw = values.get(item.client_key)
    const qty = raw === undefined ? item.qty : Number(raw.trim().replace(',', '.'))
    if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Рядок ${index + 1}: вкажіть кількість більше нуля`)
    return { ...item, qty, total: Math.round(qty * item.purchase_price) }
  })
}
