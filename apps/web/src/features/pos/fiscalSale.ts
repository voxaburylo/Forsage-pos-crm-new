export interface FiscalSaleSourceItem {
  name: string
  sku: string
  unit?: string | null
  barcode?: string | null
  qty: number
  unitPrice: number
  discount: number
  isService?: boolean
}

export interface FiscalSaleItem {
  name: string
  vendor_code: string
  barcode?: string | null
  unit?: string | null
  qty: number
  unit_price: number
  amount: number
  discount: number
  is_service?: boolean
}

export interface FiscalIntentUnknown {
  operationId: string
  message: string
}

export function buildFiscalSaleItems(
  items: FiscalSaleSourceItem[],
  totalReceiptDiscount: number,
): FiscalSaleItem[] {
  const grossLines = items.map((item) => Math.max(0, Math.round(item.unitPrice * item.qty)))
  const lineDiscounts = items.map((item, index) =>
    Math.min(grossLines[index], Math.max(0, Math.round(Number(item.discount) || 0))),
  )
  const netLines = grossLines.map((gross, index) => gross - lineDiscounts[index])
  const lineDiscountTotal = lineDiscounts.reduce((sum, amount) => sum + amount, 0)
  let remainingNet = netLines.reduce((sum, amount) => sum + amount, 0)
  // Line discounts are already assigned to their products. Only the extra
  // receipt discount/bonus is distributed, using the net product amounts.
  let remainingDiscount = Math.min(remainingNet,
    Math.max(0, Math.round(Number(totalReceiptDiscount) || 0) - lineDiscountTotal),
  )

  return items.map((item, index) => {
    const gross = grossLines[index]
    const net = netLines[index]
    const share = remainingDiscount <= 0 || remainingNet <= 0
      ? 0 : Math.min(net, Math.round(remainingDiscount * net / remainingNet))
    const discount = lineDiscounts[index] + share

    remainingDiscount -= share
    remainingNet -= net

    return {
      name: item.name,
      vendor_code: item.sku || item.name,
      barcode: item.barcode ?? null,
      unit: item.unit ?? null,
      qty: item.qty,
      unit_price: item.unitPrice,
      amount: gross - discount,
      discount,
      is_service: item.isService === true,
    }
  })
}

export function parseFiscalIntentUnknown(error: unknown): FiscalIntentUnknown | null {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const match = raw.match(/FISCAL_INTENT_UNKNOWN\|([^|\r\n]+)\|([^\r\n]+)/)
  if (!match) return null
  return {
    operationId: match[1].trim(),
    message: match[2].trim(),
  }
}
