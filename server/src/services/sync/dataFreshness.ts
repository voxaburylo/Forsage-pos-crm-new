import { pool } from '../../db/pg.js'

/**
 * «Дані станом на»: коли сервер востаннє отримав зміни від локальної програми.
 * Основна база живе на касі; веб лише показує копію, тож власник має бачити, наскільки вона свіжа.
 * Беремо найпізніше з: залишків, які каса надіслала, і останнього чека чи накладної.
 */
export async function lastLocalDataAt(tenantId: string): Promise<string | null> {
  const result = await pool.query<{ last_at: Date | string | null }>(
    `SELECT GREATEST(
       (SELECT max(updated_at) FROM local_balance_mirror WHERE tenant_id = $1),
       (SELECT max(created_at) FROM sales WHERE tenant_id = $1),
       (SELECT max(updated_at) FROM supply_invoices WHERE tenant_id = $1)
     ) AS last_at`,
    [tenantId],
  )
  const value = result.rows[0]?.last_at
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
