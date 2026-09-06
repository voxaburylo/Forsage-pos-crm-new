import { createHash, randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../../db/localDatabase'
import { LocalStaffRepository } from '../staffRepository'
import {
  DEFAULT_TENANT_ID,
  type LocalFiscalIntentResolution,
  type LocalFiscalReturnIntentCancelInput,
  type LocalFiscalReturnIntentResolution,
  type LocalFiscalReturnIntentScope,
  type LocalFiscalSaleIntentResult,
  type LocalFiscalReturnRequest,
  type LocalFiscalSaleRequest,
  type LocalFiscalSaleIntentState,
  type LocalUnresolvedFiscalReturnIntent,
  type LocalProduct,
  type LocalSaleCheckoutInput,
  type LocalSaleCheckoutResult,
  type LocalSalePaymentInput,
} from '../../db/localTypes'

export function nowIso(): string {
  return new Date().toISOString()
}

export const businessDateFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Kyiv',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function businessDateKey(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : businessDateFormatter.format(date)
}

export function dayStamp(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

export function money(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value)
}

export function lineTotal(qty: number, unitPrice: number, discount = 0): number {
  return Math.max(0, money(qty * unitPrice) - money(discount))
}

export function paymentMethod(payments: LocalSalePaymentInput[]): LocalSaleCheckoutResult['payment_method'] {
  const methods = Array.from(new Set(payments.map((payment) => payment.method)))
  return methods.length === 1 ? methods[0] : 'mixed'
}

export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  )
}

export function payloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex')
}

export function operationId(value: unknown): string | null {
  const normalized = String(value ?? '').trim()
  if (!normalized) return null
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/.test(normalized)) {
    throw new Error('Некоректний номер операції каси')
  }
  return normalized
}

export interface FiscalIntentRow {
  operation_kind: 'sale' | 'return'
  operation_id: string
  tenant_id: string
  cashier_id: string
  state: LocalFiscalSaleIntentState
  payload_hash: string
  checkout_hash: string
  checkout_json: string
  fiscal_items_json: string
  fiscal_pay_json: string
  fiscal_comment: string | null
  fiscal_result_json: string | null
  checkout_result_json: string | null
  last_error: string | null
  fiscal_number: string | null
  created_at: string
  updated_at: string
}

export interface ReturnableSaleItemRow {
  id: string
  product_id: string
  product_name: string
  sku: string
  unit: string
  qty: number
  unit_price: number
  discount: number
  total: number
  core_deposit_amount: number
  already_returned_qty: number
  already_refunded_kopecks: number
}

export interface RefundPoolAllocation {
  productRefundPool: number
  lineRefunds: Map<string, number>
}

export function allocateRefundPool(
  saleTotal: number,
  items: ReturnableSaleItemRow[],
): RefundPoolAllocation {
  if (!Number.isFinite(saleTotal) || saleTotal < 0) {
    throw new Error('У чеку вказано некоректну суму')
  }

  const weighted = items.map((item) => {
    const qty = Number(item.qty)
    const unitPrice = Number(item.unit_price)
    const discount = Number(item.discount ?? 0)
    const coreDeposit = Number(item.core_deposit_amount ?? 0)
    if (
      !Number.isFinite(qty)
      || qty <= 0
      || !Number.isFinite(unitPrice)
      || unitPrice < 0
      || !Number.isFinite(discount)
      || discount < 0
      || !Number.isFinite(coreDeposit)
      || coreDeposit < 0
    ) {
      throw new Error('У чеку є некоректна позиція')
    }
    return {
      id: item.id,
      weight: Math.max(0, (unitPrice * qty) - discount),
      coreTotal: Math.max(0, coreDeposit * qty),
    }
  })

  const lineNetTotal = weighted.reduce((sum, item) => sum + item.weight, 0)
  const coreTotal = weighted.reduce((sum, item) => sum + item.coreTotal, 0)
  const productRefundPool = Math.min(
    money(lineNetTotal),
    Math.max(0, money(saleTotal) - money(coreTotal)),
  )
  const lineRefunds = new Map<string, number>()
  if (productRefundPool <= 0 || lineNetTotal <= 0) {
    for (const item of weighted) lineRefunds.set(item.id, 0)
    return { productRefundPool, lineRefunds }
  }

  const allocations = weighted.map((item) => {
    const raw = (item.weight * productRefundPool) / lineNetTotal
    const base = Math.floor(raw)
    return { id: item.id, base, fraction: raw - base }
  })
  let remainder = productRefundPool - allocations.reduce((sum, item) => sum + item.base, 0)
  const ranked = [...allocations].sort(
    (left, right) => right.fraction - left.fraction || left.id.localeCompare(right.id),
  )
  for (const item of ranked) {
    const extra = remainder > 0 ? 1 : 0
    lineRefunds.set(item.id, item.base + extra)
    remainder -= extra
  }
  return { productRefundPool, lineRefunds }
}

