import { z } from 'zod'

const amount = z.number().finite()
const count = z.number().int().nonnegative()
const schema = z.object({
  total_revenue: amount,
  cogs: amount,
  gross_profit: amount,
  total_receipts: count,
  average_receipt: amount,
  daily: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
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
export function parseDashboardData(value: unknown): DashboardData {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error('INCOMPLETE_DASHBOARD')
  return result.data
}
