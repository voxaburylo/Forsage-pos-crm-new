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
  const grossLines = items.map((item) =>
    Math.max(0, Math.round(Number(item.unitPrice) * Number(item.qty))),
  )
  const grossTotal = grossLines.reduce((sum, amount) => sum + amount, 0)
  let remainingDiscount = Math.min(
    Math.max(0, Math.round(Number(totalReceiptDiscount) || 0)),
    grossTotal,
  )
  let remainingGross = grossTotal

  return items.map((item, index) => {
    const gross = grossLines[index]
    const isLast = index === items.length - 1
    const share = remainingDiscount <= 0 || remainingGross <= 0
      ? 0
      : isLast
        ? Math.min(gross, remainingDiscount)
        : Math.min(gross, Math.round(remainingDiscount * gross / remainingGross))

    remainingDiscount -= share
    remainingGross -= gross

    return {
      name: item.name,
      vendor_code: item.sku || item.name,
      barcode: item.barcode ?? null,
      unit: item.unit ?? null,
      qty: item.qty,
      unit_price: item.unitPrice,
      amount: gross - share,
      discount: share,
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
