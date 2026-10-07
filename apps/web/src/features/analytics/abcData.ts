import { z } from 'zod'
import { businessDateKey } from '@/lib/businessDate'

const abcRows = z.array(z.object({
  id: z.string().min(1), sku: z.string(), name: z.string().min(1),
  currentStock: z.number().finite(), soldQty: z.number().finite(),
  profit: z.number().int().safe(), abc_class: z.enum(['A', 'B', 'C', 'Z']),
  cumulative_pct: z.number().finite().min(0).max(100),
})).refine(rows => new Set(rows.map(row => row.id)).size === rows.length)

export type ABCItem = z.infer<typeof abcRows>[number]

export function parseAbcRows(data: unknown): ABCItem[] {
  const parsed = abcRows.safeParse(data)
  if (!parsed.success) throw new Error('Товарний звіт містить неповні або некоректні дані')
  return parsed.data
}

/** Exactly N Kyiv calendar days, including today. Keep in sync with the API. */
export function abcDateRange(daysValue = '90', today = businessDateKey()) {
  const days = Number(daysValue)
  if (!/^[1-9]\d*$/.test(daysValue) || !Number.isSafeInteger(days) || days > 3660) {
    throw new Error('Невірна кількість днів для звіту')
  }
  const start = new Date(today + 'T12:00:00Z')
  start.setUTCDate(start.getUTCDate() - days + 1)
  return { startDate: start.toISOString().slice(0, 10), endDate: today }
}
