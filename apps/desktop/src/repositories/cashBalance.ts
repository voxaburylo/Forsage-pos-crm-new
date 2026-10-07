import type { LocalDatabase } from '../db/localDatabase'

export interface CashBreakdown {
  opening_cash: number
  cash_sales: number
  cash_returns: number
  cash_in: number
  cash_out: number
  expected_amount: number
}

export function cashAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Некоректна сума в обліку каси. Перевірте касові операції.')
  return value
}

/** Exact signed arithmetic; do not hide shortages or lose kopecks to overflow. */
export function cashSum(...values: number[]): number {
  if (values.some(value => !Number.isSafeInteger(value))) throw new Error('Некоректна сума в обліку каси')
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n)
  const result = Number(total)
  if (!Number.isSafeInteger(result)) throw new Error('Сума каси перевищує допустиму точність')
  return result
}

/** One SQL statement gives the drawer balance and its components the same snapshot. */
export function readOpenCashBreakdown(db: LocalDatabase, tenantId: string, shiftId: string | null | undefined): CashBreakdown {
  if (!shiftId) throw new Error('Потрібна відкрита касова зміна')
  const row = db.prepare(`
    SELECT s.opening_cash,
      COALESCE(SUM(CASE WHEN c.type = 'sale_cash' THEN c.amount ELSE 0 END), 0) AS cash_sales,
      COALESCE(SUM(CASE WHEN c.type = 'return_cash' THEN c.amount ELSE 0 END), 0) AS cash_returns,
      COALESCE(SUM(CASE WHEN c.type = 'cash_in' THEN c.amount ELSE 0 END), 0) AS cash_in,
      COALESCE(SUM(CASE WHEN c.type IN ('cash_out', 'salary_payout', 'supplier_payment') THEN c.amount ELSE 0 END), 0) AS cash_out,
      SUM(CASE WHEN c.id IS NOT NULL AND (
        typeof(c.amount) <> 'integer' OR c.amount < 0 OR c.amount > 9007199254740991 OR
        c.type NOT IN ('sale_cash', 'return_cash', 'cash_in', 'cash_out', 'salary_payout', 'supplier_payment')
      ) THEN 1 ELSE 0 END) AS invalid_count
    FROM shifts s
    LEFT JOIN cash_operations c ON c.shift_id = s.id AND c.tenant_id = s.tenant_id AND c.deleted_at IS NULL
    WHERE s.id = ? AND s.tenant_id = ? AND s.status = 'open' AND s.deleted_at IS NULL
    GROUP BY s.id, s.opening_cash
  `).get(shiftId, tenantId) as (Omit<CashBreakdown, 'expected_amount'> & { invalid_count: number }) | undefined
  if (!row) throw new Error('Касову зміну не знайдено або вже закрито')
  if (row.invalid_count !== 0) throw new Error('Некоректні касові операції. Звірку та закриття заблоковано до перевірки.')
  const { opening_cash, cash_sales, cash_returns, cash_in, cash_out } = row
  for (const value of [opening_cash, cash_sales, cash_returns, cash_in, cash_out]) cashAmount(value)
  return { opening_cash, cash_sales, cash_returns, cash_in, cash_out,
    expected_amount: cashSum(opening_cash, cash_sales, cash_in, -cash_returns, -cash_out) }
}

export function readOpenCashBalance(db: LocalDatabase, tenantId: string, shiftId: string | null | undefined): number {
  return readOpenCashBreakdown(db, tenantId, shiftId).expected_amount
}
