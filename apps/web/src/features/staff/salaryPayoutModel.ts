// 23.11.2026 (власник): касир наприкінці дня видає зарплату з каси, потім закриває зміну.
// Якщо готівки в касі бракує — власник доносить свої гроші, і касир видає «коштами власника».
export interface PayoutRow {
  employee_id: string
  employee_name: string
  role: string
  earned: number
  paid: number
  penalty: number
  pending_day_rate: number
  due: number
}

export const NOT_ENOUGH_CASH = 'У касі недостатньо готівки'

export function payoutRows(rows: unknown): PayoutRow[] {
  if (!Array.isArray(rows)) return []
  return rows
    .filter((row): row is PayoutRow => !!row && typeof row === 'object' && typeof (row as PayoutRow).employee_id === 'string')
    .map(row => ({ ...row, due: Math.max(0, Math.round(Number(row.due) || 0)) }))
}

export function payoutTotal(rows: PayoutRow[]): number {
  return rows.reduce((sum, row) => sum + row.due, 0)
}

/** Пояснення до відмови: коли бракує готівки — підказати, що робити, а не лише «помилка». */
export function payoutErrorText(message: string): string {
  if (message.includes(NOT_ENOUGH_CASH)) return message + '. Якщо власник доніс свої гроші — натисніть «Коштами власника».'
  return message
}
