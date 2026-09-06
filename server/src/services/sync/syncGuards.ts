/**
 * Винесено з `syncService.ts` без зміни поведінки — див. `REFACTOR_PLAN.md`,
 * ітерація 4. У файлі на 4900 рядків помилку не видно очима.
 */

import { AppError } from '../../middleware/errorHandler.js'
import { isUuid } from './syncCore.js'

export async function assertSyncCashboxHasFunds(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> },
  tenantId: string,
  shiftId: string,
  amount: number,
  occurredAt: string,
): Promise<void> {
  const shift = await client.query(
    `SELECT id, opening_cash, status, opened_at, closed_at FROM shifts
     WHERE id = $1 AND tenant_id = $2
       AND opened_at <= $3::timestamptz
       AND (closed_at IS NULL OR closed_at >= $3::timestamptz)
     FOR UPDATE`,
    [shiftId, tenantId, occurredAt],
  )
  if (!shift.rowCount) {
    throw new AppError('SHIFT_REQUIRED', 'Касова зміна не знайдена або оплата не належить до часу її роботи', 409)
  }
  const balance = await client.query(
    `SELECT GREATEST(0,
       COALESCE($3::bigint, 0)
       + COALESCE((SELECT SUM(CASE
           WHEN sale.payment_method = 'cash' THEN COALESCE(NULLIF(sale.cash_amount, 0), sale.total)
           ELSE COALESCE(sale.cash_amount, 0)
         END)
         FROM sales sale
         WHERE sale.shift_id = $1 AND sale.tenant_id = $2 AND sale.status = 'completed'
           AND NOT EXISTS (
             SELECT 1 FROM customer_orders order_row
             WHERE order_row.tenant_id = $2 AND order_row.sale_id = sale.id
           )), 0)
       + COALESCE((SELECT SUM(CASE WHEN op.type = 'in' THEN op.amount ELSE -op.amount END)
         FROM cash_operations op WHERE op.shift_id = $1 AND op.tenant_id = $2), 0)
     )::bigint AS available`,
    [shiftId, tenantId, Number(shift.rows[0].opening_cash ?? 0)],
  )
  const available = Number(balance.rows[0]?.available ?? 0)
  if (available < amount) {
    throw new AppError(
      'CASHBOX_INSUFFICIENT_FUNDS',
      `У касі недостатньо грошей. Доступно ${(available / 100).toFixed(2)} грн, потрібно ${(amount / 100).toFixed(2)} грн.`,
      409,
    )
  }
}

/**
 * Products point at brands and categories by foreign key. When the reference row
 * has not reached the server yet, Postgres answers with a constraint name that is
 * meaningless to the person at the till, so translate it into the actual problem.
 */
export async function assertProductReferenceExists(
  client: { query: (sql: string, params: any[]) => Promise<{ rowCount: number | null }> },
  tenantId: string,
  table: 'brands' | 'categories',
  referenceId: string | null,
  label: string,
): Promise<void> {
  if (!referenceId || !isUuid(referenceId)) return
  const found = await client.query(
    `SELECT 1 FROM ${table} WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [referenceId, tenantId],
  )
  if (found.rowCount) return
  throw new AppError(
    'SYNC_PRODUCT_REFERENCE_MISSING',
    `${label} товару ще не синхронізовано з сервером. Товар буде надіслано разом із нею.`,
    409,
  )
}

export async function ensureFreeAmountProduct(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, any>>, rowCount: number | null }> },
  tenantId: string,
): Promise<string> {
  const sku = 'LOCAL-FREE-AMOUNT'
  const existing = await client.query(
    'SELECT id FROM products WHERE tenant_id = $1 AND sku = $2 AND deleted_at IS NULL LIMIT 1',
    [tenantId, sku],
  )
  if (existing.rowCount && existing.rowCount > 0) return String(existing.rows[0].id)

  const inserted = await client.query(
    `INSERT INTO products (
      tenant_id, sku, name, barcode, retail_price, purchase_price, qty_on_hand,
      unit, is_active, is_service, notes, created_at, updated_at
    )
    VALUES ($1, $2, 'Вільна сума офлайн-каси', NULL, 0, 0, 0, 'шт', true, true, $3, now(), now())
    ON CONFLICT (tenant_id, sku) DO UPDATE SET
      is_service = true,
      is_active = true,
      deleted_at = NULL,
      updated_at = now()
    RETURNING id`,
    [tenantId, sku, 'Службовий товар для чеків з довільною сумою, створений синхронізацією'],
  )

  return String(inserted.rows[0].id)
}
