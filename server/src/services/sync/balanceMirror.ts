import { runTransaction } from '../../db/pg.js'
import { AppError } from '../../middleware/errorHandler.js'
import { isUuid } from './syncCore.js'
import { verify } from 'node:crypto'

export interface BalanceSnapshot {
  source_version: number
  products: Array<{ id: string; qty_on_hand: number }>
  customers: Array<{ id: string; debt_balance: number; deposit_balance: number; bonus_balance: number }>
}

export async function requiresSignedBalances(tenantId: string): Promise<boolean> {
  return runTransaction(async client => {
    const result=await client.query('SELECT 1 FROM local_mirror_authorities WHERE tenant_id=$1',[tenantId])
    return Boolean(result.rowCount)
  })
}

export function validateBalanceSnapshot(value: any): BalanceSnapshot {
  if (!value || !Number.isSafeInteger(value.source_version) || value.source_version < 0
    || !Array.isArray(value.products) || !Array.isArray(value.customers)
    || value.products.length > 40000 || value.customers.length > 10000) {
    throw new AppError('MIRROR_INVALID', 'Некоректний знімок локальних залишків', 422)
  }
  const unique = (rows: any[]) => new Set(rows.map(row => row?.id)).size === rows.length
  if (!unique(value.products) || !unique(value.customers)) throw new AppError('MIRROR_INVALID', 'Повторні рядки знімка', 422)
  const products = value.products.map((row: any) => {
    if (!isUuid(row?.id) || typeof row.qty_on_hand !== 'number' || !Number.isFinite(row.qty_on_hand)) {
      throw new AppError('MIRROR_INVALID', 'Некоректний залишок товару', 422)
    }
    return { id: row.id, qty_on_hand: row.qty_on_hand }
  })
  const customers = value.customers.map((row: any) => {
    if (!isUuid(row?.id) || !['debt_balance','deposit_balance','bonus_balance'].every(key =>
      Number.isSafeInteger(row[key]) && row[key] >= 0 && row[key] <= 2147483647)) {
      throw new AppError('MIRROR_INVALID', 'Некоректний баланс клієнта', 422)
    }
    return { id: row.id, debt_balance: row.debt_balance, deposit_balance: row.deposit_balance, bonus_balance: row.bonus_balance }
  })
  return { source_version: value.source_version, products, customers }
}

/** Snapshot update is independent from document replay; old deltas cannot overwrite it. */
export async function applyBalanceSnapshot(tenantId: string, deviceId: string, raw: unknown): Promise<void> {
  const snapshot = validateBalanceSnapshot(raw)
  const rows = [
    ...snapshot.products.map(({ id, ...balances }) => ({ entity_type: 'product', entity_id: id, balances })),
    ...snapshot.customers.map(({ id, ...balances }) => ({ entity_type: 'customer', entity_id: id, balances })),
  ]
  await runTransaction(async client => {
    const authority = await client.query('SELECT device_id, public_key FROM local_mirror_authorities WHERE tenant_id=$1 FOR UPDATE', [tenantId])
    if (authority.rows[0]?.device_id !== deviceId) {
      throw new AppError('MIRROR_SOURCE_MISMATCH', 'Ця локальна база не зареєстрована як основна для магазину', 403)
    }
    const { signature, ...signedSnapshot } = raw as any
    const signedText = JSON.stringify({ tenant_id: tenantId, device_id: deviceId, snapshot: signedSnapshot })
    if (typeof signature !== 'string' || !verify(null, Buffer.from(signedText), authority.rows[0].public_key, Buffer.from(signature,'base64'))) {
      throw new AppError('MIRROR_SIGNATURE_INVALID', 'Підпис локального знімка не підтверджено', 403)
    }
    // A reused version with different contents is an integrity failure, not last-writer-wins.
    const conflicts = await client.query(`SELECT m.entity_id FROM local_balance_mirror m
      JOIN jsonb_to_recordset($2::jsonb) AS v(entity_type text, entity_id uuid, balances jsonb)
        ON m.entity_type=v.entity_type AND m.entity_id=v.entity_id
      WHERE m.tenant_id=$1 AND m.source_version=$3 AND m.balances IS DISTINCT FROM v.balances LIMIT 1`,
      [tenantId, JSON.stringify(rows), snapshot.source_version])
    if (conflicts.rowCount) throw new AppError('MIRROR_VERSION_CONFLICT', 'Одна версія локальної бази має різні залишки; потрібна перевірка', 409)
    await client.query(`INSERT INTO local_balance_mirror(tenant_id, entity_type, entity_id, source_version, balances)
      SELECT $1, v.entity_type, v.entity_id, $3, v.balances
      FROM jsonb_to_recordset($2::jsonb) AS v(entity_type text, entity_id uuid, balances jsonb)
      ON CONFLICT(tenant_id,entity_type,entity_id) DO UPDATE SET source_version=EXCLUDED.source_version,
        balances=EXCLUDED.balances, updated_at=clock_timestamp()
      WHERE local_balance_mirror.source_version < EXCLUDED.source_version`, [tenantId, JSON.stringify(rows), snapshot.source_version])
    await client.query("SELECT set_config('app.stock_source_type','local_mirror',true)")
    await client.query("SELECT set_config('app.stock_source_id',$1,true)", [deviceId + ':' + snapshot.source_version])
    await client.query(`UPDATE products p SET qty_on_hand=(m.balances->>'qty_on_hand')::numeric
      FROM local_balance_mirror m WHERE m.tenant_id=$1 AND m.entity_type='product'
        AND p.tenant_id=m.tenant_id AND p.id=m.entity_id AND p.id=ANY($2::uuid[])
        AND p.qty_on_hand IS DISTINCT FROM (m.balances->>'qty_on_hand')::numeric`, [tenantId, snapshot.products.map(row => row.id)])
    await client.query(`UPDATE customers c SET debt_balance=(m.balances->>'debt_balance')::bigint,
        deposit_balance=(m.balances->>'deposit_balance')::bigint, bonus_balance=(m.balances->>'bonus_balance')::bigint
      FROM local_balance_mirror m WHERE m.tenant_id=$1 AND m.entity_type='customer'
        AND c.tenant_id=m.tenant_id AND c.id=m.entity_id AND c.id=ANY($2::uuid[])
        AND (c.debt_balance,c.deposit_balance,c.bonus_balance) IS DISTINCT FROM
          ((m.balances->>'debt_balance')::bigint,(m.balances->>'deposit_balance')::bigint,(m.balances->>'bonus_balance')::bigint)`,
      [tenantId, snapshot.customers.map(row => row.id)])
  })
}
