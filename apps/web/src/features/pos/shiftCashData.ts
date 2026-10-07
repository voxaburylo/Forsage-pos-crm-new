import { z } from 'zod'
import type { ShiftReport } from '@/types/shift'
import type { ExpectedCash } from './shiftApi'

const money = z.number().int().refine(Number.isSafeInteger)
const positive = money.refine(value => value >= 0)
const methods = z.object({ cash: positive, card: positive, transfer: positive, account: positive, debt: positive })
const exactSum = (values: number[]) => values.reduce((sum, value) => sum + BigInt(value), 0n)
const cashSchema = z.object({
  opening_cash: positive, cash_sales: positive, cash_returns: positive,
  cash_in: positive, cash_out: positive, expected_amount: money,
}).refine(cash => exactSum([cash.opening_cash, cash.cash_sales, cash.cash_in, -cash.cash_returns, -cash.cash_out]) === BigInt(cash.expected_amount))

export function parseExpectedCash(value: unknown): ExpectedCash {
  const parsed = cashSchema.safeParse(value)
  if (!parsed.success) throw new Error('Дані готівки неповні або некоректні. Повторіть завантаження; звірку заблоковано.')
  return parsed.data
}

const closingSchema = z.object({
  shift: z.object({ id: z.string().min(1), cashier_id: z.string().min(1), status: z.literal('open'), opening_cash: positive }),
  cash_breakdown: cashSchema,
  total_sales: positive, gross_revenue: positive, refund_total: positive, total_revenue: money,
  payment_received_total: positive, payment_refunded_total: positive, payment_net_total: money,
  unassigned_refunds_count: positive, by_method: methods, refunds_by_method: methods,
  sales: z.array(z.object({ id: z.string().min(1), status: z.string(), total: positive })),
})

export function parseClosingSnapshot(value: unknown, shiftId: string, cashierId: string): ShiftReport & { cash_breakdown: ExpectedCash } {
  const parsed = closingSchema.safeParse(value)
  const invalid = () => { throw new Error('Звіт зміни неповний або зміна змінилася. Оновіть програму та повторно відкрийте звірку.') }
  if (!parsed.success) return invalid()
  const r = parsed.data
  const settled = r.sales.filter(sale => sale.status === 'completed' || sale.status === 'returned')
  if (r.shift.id !== shiftId || r.shift.cashier_id !== cashierId || r.shift.opening_cash !== r.cash_breakdown.opening_cash
    || r.total_sales !== settled.length || new Set(r.sales.map(sale => sale.id)).size !== r.sales.length
    || exactSum(settled.map(sale => sale.total)) !== BigInt(r.gross_revenue)
    || exactSum([r.gross_revenue, -r.refund_total]) !== BigInt(r.total_revenue)
    || exactSum([r.by_method.cash, r.by_method.card, r.by_method.transfer, r.by_method.account]) !== BigInt(r.payment_received_total)
    || exactSum(Object.values(r.refunds_by_method)) !== BigInt(r.refund_total)
    || exactSum([r.refund_total, -r.refunds_by_method.debt]) !== BigInt(r.payment_refunded_total)
    || exactSum([r.payment_received_total, -r.payment_refunded_total]) !== BigInt(r.payment_net_total)) return invalid()
  return value as ShiftReport & { cash_breakdown: ExpectedCash }
}

export function parseCountedCash(value: string): number | null {
  const text = value.trim()
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(text)) return null
  const [whole, fraction = ''] = text.replace(',', '.').split('.')
  const amount = Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')))
  return Number.isSafeInteger(amount) ? amount : null
}
