/** Звіт «Контроль»: дані з /api/v1/reports/control і прості розрахунки для показу. Суми — копійки. */
export interface PeriodTotals { receipts: number; revenue: number; returns: number; discounts: number; profit: number; profit_known_revenue: number }
export interface ControlLine {
  sale_number: string; completed_at: string; product_id: string; name: string; sku: string | null
  qty: number; total: number; cost: number; margin: number; margin_pct: number | null; employee: string | null
}
export interface StaleProduct { id: string; name: string; sku: string | null; qty_on_hand: number; stock_cost: number; last_sale_at: string | null; storage_bin: string | null }
export interface ControlReport {
  period: { from: string; to: string }; previous_period: { from: string; to: string }
  current: PeriodTotals; previous: PeriodTotals
  below_cost: ControlLine[]; low_margin: ControlLine[]; stale: StaleProduct[]
  margin_pct: number; stale_days: number
}

/** Зміна у відсотках відносно попереднього періоду; null — порівнювати нема з чим. */
export function changePct(current: number, previous: number): number | null {
  if (!previous) return null
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10
}

export const COMPARE_ROWS: Array<{ key: keyof PeriodTotals; label: string; money: boolean; goodWhenUp: boolean }> = [
  { key: 'revenue', label: 'Виручка', money: true, goodWhenUp: true },
  { key: 'profit', label: 'Валовий прибуток', money: true, goodWhenUp: true },
  { key: 'receipts', label: 'Чеків', money: false, goodWhenUp: true },
  { key: 'returns', label: 'Повернення', money: true, goodWhenUp: false },
  { key: 'discounts', label: 'Знижки', money: true, goodWhenUp: false },
]

export function lossTotal(lines: readonly ControlLine[]): number {
  return lines.reduce((sum, line) => sum + Math.min(0, line.margin), 0)
}

export function staleStockCost(rows: readonly StaleProduct[]): number {
  return rows.reduce((sum, row) => sum + row.stock_cost, 0)
}

/** Перший день поточного місяця і сьогодні — за київським календарем. */
export function defaultPeriod(now = new Date()): { from: string; to: string } {
  const today = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' })
  return { from: today.slice(0, 8) + '01', to: today }
}
