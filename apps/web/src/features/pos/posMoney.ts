/** Prices and line amounts are kopecks. Round each line exactly as local checkout does. */
export function posLineGross(unitPrice: number, qty: number): number {
  return Math.max(0, Math.round(unitPrice * qty))
}

export function posLineAmounts(item: { unitPrice: number; qty: number; discount: number; discountPct?: number }) {
  const gross = posLineGross(item.unitPrice, item.qty)
  const requested = item.discountPct !== undefined && Number.isFinite(item.discountPct)
    ? Math.round(gross * Math.max(0, Math.min(100, item.discountPct)) / 100)
    : Math.round(Number.isFinite(item.discount) ? item.discount : 0)
  const discount = Math.max(0, Math.min(gross, requested))
  return { discount, total: gross - discount }
}

export function posCoreTotal(item: { qty: number; requiresCoreReturn?: boolean; coreDepositAmount?: number }) {
  return item.requiresCoreReturn ? posLineGross(Math.round(item.coreDepositAmount ?? 0), item.qty) : 0
}
