import { z } from 'zod'
import { validStaffRange } from './staffData'

const amount = z.number().finite()
const count = z.number().int().nonnegative()
const schema = z.object({
  total_revenue: amount,
  cogs: amount,
  gross_profit: amount,
  total_receipts: count,
  average_receipt: amount,
  daily: z.array(z.object({
    date: z.string().refine(value => validStaffRange(value, value)),
    revenue: amount,
    profit: amount,
  })),
  low_stock: count,
  overdue_count: count,
  debt: z.object({ count, total: amount }),
  inventory: z.object({ purchase_value: amount, retail_value: amount }),
})

const tireSchema = z.array(z.object({
  employee_id: z.string().min(1),
  employee_name: z.string(),
  services_qty: amount,
  service_revenue: amount,
  commission_earned: amount,
  earned: amount,
  paid: amount,
  due: amount,
}))
export type DashboardData = z.infer<typeof schema>
export type DashboardTireWorker = z.infer<typeof tireSchema>[number]

export function parseDashboardTires(value: unknown): DashboardTireWorker[] {
  const result = tireSchema.safeParse(value)
  if (!result.success) throw new Error('INCOMPLETE_TIRE_REPORT')
  return result.data
}

// Missing sections are not a zero balance. Both local and web reads must
// provide a complete, finite result before the statistics page displays it.
export function parseDashboardData(value: unknown, expected: {
  startDate?: string; endDate?: string; canSeeProfit?: boolean
} = {}): DashboardData {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error('INCOMPLETE_DASHBOARD')
  const report = result.data
  // Costs may contain fractional kopecks for fractional stock quantities.
  // Preserve that precision; tolerate only floating-point summation noise.
  const equal = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.000001
  const { startDate, endDate } = expected
  if (new Set(report.daily.map(day => day.date)).size !== report.daily.length
    || !equal(report.daily.reduce((sum, day) => sum + day.revenue, 0), report.total_revenue)
    || !equal(report.daily.reduce((sum, day) => sum + day.profit, 0), report.gross_profit)
    || report.average_receipt !== (report.total_receipts ? Math.round(report.total_revenue / report.total_receipts) : 0)
    // The web server intentionally masks all profit fields for non-owner roles.
    || (expected.canSeeProfit !== false && !equal(report.total_revenue - report.cogs, report.gross_profit))
    || ((startDate !== undefined || endDate !== undefined) && (!startDate || !endDate
      || !validStaffRange(startDate, endDate) || report.daily.some(day => day.date < startDate || day.date > endDate)))) {
    throw new Error('INCOMPLETE_DASHBOARD')
  }
  return report
}
