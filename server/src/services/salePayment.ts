import { createHash } from 'node:crypto'
import type { CreateSaleInput } from '../validators/saleSchema.js'
import { AppError } from '../middleware/errorHandler.js'

export type SaleAmounts = {
  cashAmount: number
  cardAmount: number
  transferAmount: number
  bonusesEarned: number
}

export function calculateSaleAmounts(input: CreateSaleInput, paymentTotal: number): SaleAmounts {
  let cashAmount = 0
  let cardAmount = 0
  let transferAmount = 0

  if (input.payment_method === 'mixed') {
    cashAmount = input.cash_amount ?? 0
    cardAmount = input.card_amount ?? 0
    if (cashAmount + cardAmount !== paymentTotal) {
      throw new AppError(
        'PAYMENT_AMOUNT_MISMATCH',
        `Сума готівки та картки має дорівнювати сумі чека: ${(paymentTotal / 100).toFixed(2)} грн`,
        422,
      )
    }
  } else if (input.payment_method === 'cash') {
    cashAmount = paymentTotal
  } else if (input.payment_method === 'card') {
    cardAmount = paymentTotal
  } else if (input.payment_method === 'transfer') {
    transferAmount = paymentTotal
  }

  return { cashAmount, cardAmount, transferAmount, bonusesEarned: 0 }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    )
  }
  return value
}

export function saleRequestHash(input: CreateSaleInput): string {
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')
}
