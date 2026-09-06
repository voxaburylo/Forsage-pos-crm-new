import type { LocalDatabase } from '../db/localDatabase'

/** Signed ledger balance: never hide a shortage by clamping it to zero. */
export function readOpenCashBalance(db: LocalDatabase, tenantId: string, shiftId: string | null | undefined): number {
  if (!shiftId) throw new Error('Потрібна відкрита касова зміна')
  const row = db.prepare(`
    SELECT s.opening_cash + COALESCE(SUM(CASE
      WHEN c.type IN ('sale_cash', 'cash_in') THEN c.amount
      WHEN c.type IN ('return_cash', 'cash_out', 'salary_payout', 'supplier_payment') THEN -c.amount
      ELSE 0 END), 0) AS available
    FROM shifts s
    LEFT JOIN cash_operations c ON c.shift_id = s.id AND c.tenant_id = s.tenant_id AND c.deleted_at IS NULL
    WHERE s.id = ? AND s.tenant_id = ? AND s.status = 'open' AND s.deleted_at IS NULL
    GROUP BY s.id, s.opening_cash
  `).get(shiftId, tenantId) as { available: number } | undefined
  if (!row) throw new Error('Касову зміну не знайдено або вже закрито')
  if (!Number.isFinite(row.available)) throw new Error('Некоректний залишок коштів каси')
  return row.available
}
