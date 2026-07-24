import { AppError } from '../middleware/errorHandler.js'

export interface ReturnRefundAllocationInput {
  id: string
  qty: number
  unit_price: number
  discount?: number | null
  core_deposit_amount?: number | null
}

/**
 * Allocates the amount actually paid for products across receipt lines.
 * Core deposits are excluded because they are refunded by the dedicated
 * core-return flow. Integer remainders are distributed deterministically.
 */
export function allocateReturnableLineTotals(
  saleTotal: number,
  items: ReturnRefundAllocationInput[],
): Map<string, number> {
  const normalized = items.map((item) => {
    const qty = Number(item.qty)
    const unitPrice = Number(item.unit_price)
    const discount = Number(item.discount ?? 0)
    const coreDeposit = Number(item.core_deposit_amount ?? 0)
    if (
      !Number.isFinite(qty) || qty <= 0
      || !Number.isFinite(unitPrice) || unitPrice < 0
      || !Number.isFinite(discount) || discount < 0
      || !Number.isFinite(coreDeposit) || coreDeposit < 0
    ) {
      throw new AppError('DB_ERROR', 'Некоректні суми в позиціях чека', 500)
    }
    return {
      id: item.id,
      weight: Math.max(0, unitPrice * qty - discount),
      coreTotal: Math.max(0, coreDeposit * qty),
    }
  })

  const trustedSaleTotal = Number(saleTotal)
  if (!Number.isFinite(trustedSaleTotal) || trustedSaleTotal < 0) {
    throw new AppError('DB_ERROR', 'Некоректна сума чека', 500)
  }

  const lineNetTotal = normalized.reduce((sum, item) => sum + item.weight, 0)
  const coreTotal = normalized.reduce((sum, item) => sum + item.coreTotal, 0)
  const refundPool = Math.min(
    Math.round(lineNetTotal),
    Math.max(0, Math.round(trustedSaleTotal) - Math.round(coreTotal)),
  )

  if (lineNetTotal <= 0 || refundPool <= 0) {
    return new Map(normalized.map((item) => [item.id, 0]))
  }

  const allocations = normalized.map((item) => {
    const raw = item.weight * refundPool / lineNetTotal
    const base = Math.floor(raw)
    return { id: item.id, amount: base, fraction: raw - base }
  })
  let remainder = refundPool - allocations.reduce((sum, item) => sum + item.amount, 0)
  const ranked = [...allocations].sort((a, b) => (
    b.fraction - a.fraction || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  ))
  for (const item of ranked) {
    if (remainder <= 0) break
    item.amount += 1
    remainder -= 1
  }

  return new Map(allocations.map((item) => [item.id, item.amount]))
}

