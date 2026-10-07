import { z } from 'zod'
import { businessDateKey } from '@/lib/businessDate'

const money = z.number().int().safe()
const staffRows = z.array(z.object({
  manager_id: z.string().trim().min(1), manager_name: z.string().trim().min(1),
  sales_revenue: money, sales_cogs: money, orders_revenue: money, orders_cogs: money,
  total_revenue: money, total_cogs: money, gross_profit: money, salary_cost: money.nonnegative(),
  bonus_cost: money, advance_cost: money.nonnegative(), penalty_cost: money.nonnegative(),
  total_payouts: money.nonnegative(), net_profit: money,
}).refine(row => row.total_revenue === row.sales_revenue + row.orders_revenue
  && row.total_cogs === row.sales_cogs + row.orders_cogs
  && row.gross_profit === row.total_revenue - row.total_cogs
  && row.total_payouts === row.advance_cost
  && row.net_profit === row.gross_profit - row.salary_cost - row.bonus_cost + row.penalty_cost
)).refine(rows => new Set(rows.map(row => row.manager_id)).size === rows.length
  && ['total_revenue', 'total_cogs', 'gross_profit', 'total_payouts', 'net_profit'].every(key =>
    Number.isSafeInteger(rows.reduce((sum, row) => sum + Number(row[key as keyof typeof row]), 0))))

export type StaffProfitabilityItem = z.infer<typeof staffRows>[number]
export type StaffPeriod = 'month' | 'quarter' | 'year'
export function parseStaffRows(data: unknown): StaffProfitabilityItem[] {
  const parsed = staffRows.safeParse(data)
  if (!parsed.success) throw new Error('Звіт працівників містить неповні або неузгоджені дані')
  return parsed.data
}
export function validStaffRange(startDate: string, endDate: string): boolean {
  const validDate = (value: string) => {
    const date = new Date(value + 'T00:00:00Z')
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime())
      && date.toISOString().slice(0, 10) === value && Number(value.slice(0, 4)) >= 1000
      && Number(value.slice(0, 4)) < 9999
  }
  return validDate(startDate) && validDate(endDate) && startDate <= endDate
}
export function staffDateRange(period: StaffPeriod, today = businessDateKey()) {
  const [year, month] = today.split('-').map(Number)
  const startDate = period === 'year' ? year + '-01-01' : period === 'quarter'
    ? new Date(Date.UTC(year, month - 3, 1)).toISOString().slice(0, 10) : today.slice(0, 7) + '-01'
  return { startDate, endDate: today }
}
export function staffExportRows(rows: StaffProfitabilityItem[]) {
  return parseStaffRows(rows).map(row => ({
    'Працівник': row.manager_name, 'ID працівника': row.manager_id,
    'Виручка після повернень, грн': row.total_revenue / 100,
    'Каса, грн': row.sales_revenue / 100, 'Видані замовлення, грн': row.orders_revenue / 100,
    'Собівартість, грн': row.total_cogs / 100, 'Валовий прибуток, грн': row.gross_profit / 100,
    'Нараховано зарплати, грн': row.salary_cost / 100, 'Премії та сторно, грн': row.bonus_cost / 100,
    'Утримання, грн': row.penalty_cost / 100,
    'Виплачено за вибрані дні роботи, грн': row.total_payouts / 100,
    'Результат після нарахувань, грн': row.net_profit / 100,
  }))
}
