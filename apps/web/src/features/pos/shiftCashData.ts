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

/** Коли готівки в зміні не було, рахувати нічого: поле одразу «0», а не порожнє із сірим «0.00». */
export function initialCountedCash(expectedAmount: number): string {
  return expectedAmount === 0 ? '0' : ''
}

/** Чому кнопка «Закрити зміну» неактивна — людськими словами; null, коли закрити можна. */
export function closeBlockReason(state: { loading: boolean; loadError: boolean; ready: boolean; cashText: string; pendingOfflineSales: number; offlineWeb: boolean }): string | null {
  if (state.loadError) return 'Дані зміни не завантажено. Закрийте вікно й відкрийте знову.'
  if (state.loading || !state.ready) return 'Завантажую дані зміни…'
  if (state.offlineWeb) return 'Немає інтернету: закриття зміни недоступне.'
  if (state.pendingOfflineSales > 0) return 'Спершу мають відправитися чеки з черги: ' + state.pendingOfflineSales + '.'
  if (state.cashText.trim() === '') return 'Введіть суму готівки в касі. Якщо готівки немає — введіть 0.'
  if (parseCountedCash(state.cashText) === null) return 'Суму введено неправильно. Приклад: 1250 або 1250.50'
  return null
}

/** Залишок із закриття підставляється при відкритті лише тому самому працівнику: зміни особисті. */
export function lastCloseCashKey(cashierId: string): string {
  return 'forsage_last_shift_close_cash:' + cashierId
}

export function parseCountedCash(value: string): number | null {
  const text = value.trim()
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(text)) return null
  const [whole, fraction = ''] = text.replace(',', '.').split('.')
  const amount = Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')))
  return Number.isSafeInteger(amount) ? amount : null
}
