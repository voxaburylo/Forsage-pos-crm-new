import { z } from 'zod'
import { runTransaction } from '../../db/pg.js'
import { AppError } from '../../middleware/errorHandler.js'
import { isUuid, type SyncOutboxOperation } from './syncCore.js'
import { financialCopyDeleted, lockFinancialCopy } from './financialCopyGuards.js'

const id = z.string().refine(isUuid).transform(value => value.toLowerCase())
const optionalId = id.nullable().optional().transform(value => value ?? null)
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)))
  .transform(value => new Date(value).toISOString())
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value)
const schema = z.object({
  id, shift_id: id, created_by: id, employee_id: optionalId,
  type: z.enum(['in', 'out', 'cash_in', 'cash_out', 'salary_payout', 'supplier_payment'])
    .transform(value => ['out', 'cash_out', 'salary_payout', 'supplier_payment'].includes(value) ? 'out' : 'in'),
  amount: z.number().int().positive().max(2_147_483_647),
  source: z.enum(['cashbox', 'owner_funds', 'change_fund', 'bank_account', 'business_card', 'other']).default('cashbox'),
  note: z.string().max(10000).nullable().optional().transform(value => value ?? null),
  work_date: day.nullable().optional().transform(value => value ?? null), created_at: timestamp,
})
function invalid(): never {
  throw new AppError('SYNC_CASH_OPERATION_INVALID', 'Для копії касової операції потрібні точні сума в копійках, тип, зміна і реквізити', 422)
}
function conflict(): never {
  throw new AppError('SYNC_CASH_COPY_CONFLICT', 'Копія касової операції суперечить збереженому запису. Суму не змінено; потрібна звірка.', 409)
}
function values(row: Record<string, any>, tenantId = row.tenant_id): unknown[] {
  return [row.id, tenantId, row.shift_id, row.type, Number(row.amount), row.note, row.source, row.created_by,
    row.employee_id, row.work_date instanceof Date ? row.work_date.toISOString().slice(0, 10) : row.work_date,
    new Date(row.created_at).toISOString()]
}

/** Mirror one committed local movement; never round, reissue or overwrite it. */
export async function applyCashOperationCreated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  if (operation.tenant_id !== tenantId || !isUuid(operation.aggregate_id)) invalid()
  const payload = operation.payload ?? {}
  if (payload.user_id && payload.created_by && (typeof payload.user_id !== 'string'
    || typeof payload.created_by !== 'string' || payload.user_id.toLowerCase() !== payload.created_by.toLowerCase())) invalid()
  const parsed = schema.safeParse({ ...payload, id: payload.id ?? operation.aggregate_id,
    // Older cash payloads did not persist an actor. Preserve the existing
    // transport-actor fallback only for those entries, not malformed identities.
    created_by: payload.user_id ?? payload.created_by ?? userId,
    note: payload.note ?? payload.notes ?? null, created_at: payload.created_at ?? operation.created_at })
  if (!parsed.success || parsed.data.id !== operation.aggregate_id.toLowerCase()) invalid()
  const copy = parsed.data
  await runTransaction(async client => {
    await lockFinancialCopy(client, 'cash_operation', copy.id)
    if (await financialCopyDeleted(client, tenantId, 'cash_operation', copy.id)) return
    const existing = await client.query('SELECT * FROM cash_operations WHERE id=$1 FOR UPDATE', [copy.id])
    if (existing.rowCount) {
      if (JSON.stringify(values(existing.rows[0])) !== JSON.stringify(values(copy, tenantId))) conflict()
      return
    }
    const shift = await client.query('SELECT id FROM shifts WHERE id=$1 AND tenant_id=$2', [copy.shift_id, tenantId])
    if (!shift.rowCount) throw new AppError('SYNC_CASH_COPY_REQUIRED', 'Спочатку потрібна копія первісної касової зміни', 409)
    for (const user of new Set([copy.created_by, copy.employee_id].filter(Boolean))) {
      const staff = await client.query("SELECT id FROM auth.users WHERE id=$1 AND raw_app_meta_data->>'tenant_id'=$2", [user, tenantId])
      if (!staff.rowCount) throw new AppError('SYNC_CASH_COPY_REQUIRED', 'Працівник касової операції відсутній у копії цього магазину', 409)
    }
    const inserted = await client.query(`INSERT INTO cash_operations(
      id,tenant_id,shift_id,type,amount,note,source,created_by,employee_id,work_date,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING RETURNING id`,
    [...values(copy, tenantId), operation.applied_at ?? new Date().toISOString()])
    if (!inserted.rowCount) {
      const concurrent = await client.query('SELECT * FROM cash_operations WHERE id=$1 FOR UPDATE', [copy.id])
      if (!concurrent.rowCount || JSON.stringify(values(concurrent.rows[0])) !== JSON.stringify(values(copy, tenantId))) conflict()
    }
  })
}
