import { z } from 'zod'
import { runTransaction } from '../../db/pg.js'
import { AppError } from '../../middleware/errorHandler.js'
import { isUuid, type SyncOutboxOperation } from './syncCore.js'
import { financialCopyDeleted, lockFinancialCopy, markFinancialCopyDeleted } from './financialCopyGuards.js'

const id = z.string().refine(isUuid).transform(value => value.toLowerCase())
const optionalId = id.nullable().optional().transform(value => value ?? null)
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)))
  .transform(value => new Date(value).toISOString())
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value)
const copySchema = z.object({
  id, employee_id: id, employee_name: z.string().min(1).max(200),
  amount: z.number().int().min(-2_147_483_647).max(2_147_483_647).refine(value => value !== 0),
  type: z.enum(['salary', 'bonus', 'advance', 'penalty']),
  method: z.enum(['cash', 'card', 'transfer']),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).nullable(),
  work_date: day,
  source: z.enum(['manual', 'commission', 'commission_reversal', 'daily_rate', 'daily_payout']),
  note: z.string().max(10000).nullable().optional().transform(value => value ?? null),
  shift_id: optionalId, cash_operation_id: optionalId,
  commission_source_sale_id: optionalId, commission_source_order_id: optionalId, commission_source_return_id: optionalId,
  created_by: optionalId, created_at: timestamp,
})
type Copy = z.infer<typeof copySchema>
function invalid(message: string): never { throw new AppError('SYNC_SALARY_COPY_INVALID', message, 422) }
function required(message: string): never { throw new AppError('SYNC_SALARY_COPY_REQUIRED', message, 409) }
function conflict(): never {
  throw new AppError('SYNC_SALARY_COPY_CONFLICT',
    'Копія зарплати суперечить збереженому запису або обмеженню бази. Потрібна звірка та актуальна схема сервера; суму не змінено.', 409)
}
function values(copy: Copy, tenantId: string) {
  return [copy.id, tenantId, copy.employee_id, copy.employee_name, copy.amount, copy.type, copy.method,
    copy.period, copy.work_date, copy.source, copy.note, copy.cash_operation_id,
    copy.commission_source_sale_id, copy.commission_source_order_id, copy.commission_source_return_id,
    copy.created_by, copy.created_at]
}
function storedValues(row: Record<string, any>) {
  const date = row.work_date instanceof Date ? row.work_date.toISOString().slice(0, 10) : row.work_date
  return [row.id, row.tenant_id, row.employee_id, row.employee_name, Number(row.amount), row.type, row.method,
    row.period, date, row.source, row.note, row.cash_operation_id,
    row.commission_source_sale_id, row.commission_source_order_id, row.commission_source_return_id,
    row.created_by, new Date(row.created_at).toISOString()]
}

function parseSalaryCopy(tenantId: string, operation: SyncOutboxOperation): Copy {
  if (operation.tenant_id !== tenantId || !isUuid(operation.aggregate_id)) invalid('Некоректний ідентифікатор або магазин запису зарплати')
  const payload = operation.payload ?? {}
  const parsed = copySchema.safeParse({ ...payload, id: payload.id ?? operation.aggregate_id,
    created_at: payload.created_at ?? operation.created_at })
  if (!parsed.success) invalid('Для копії зарплати потрібні точні локальні сума в копійках, працівник, дата і тип запису')
  const copy = parsed.data
  const reversal = copy.source === 'commission_reversal'
  const commission = copy.source === 'commission' || reversal
  if (copy.id !== operation.aggregate_id.toLowerCase() || (reversal ? copy.amount >= 0 : copy.amount < 0)
    || (commission && copy.type !== 'bonus')
    || (copy.source === 'daily_rate' && copy.type !== 'salary')
    || (copy.source === 'daily_payout' && copy.type !== 'advance')
    || (reversal && !copy.commission_source_return_id)
    || (!reversal && copy.commission_source_return_id)
    || (copy.source === 'commission' && !copy.commission_source_sale_id && !copy.commission_source_order_id)
    || (copy.cash_operation_id && (copy.type !== 'advance' || copy.method !== 'cash'))
    || (copy.type === 'advance' && copy.method === 'cash' && !copy.cash_operation_id)) {
    invalid('Неузгоджені реквізити локального нарахування, сторно або виплати')
  }
  return copy
}

/** Copy an already committed local payroll ledger row. Never recalculate it or pay it again. */
export async function applySalaryPaymentCreated(tenantId: string, _userId: string, operation: SyncOutboxOperation): Promise<void> {
  const copy = parseSalaryCopy(tenantId, operation)
  try {
    await runTransaction(async client => {
      await lockFinancialCopy(client, 'salary_payment', copy.id)
      if (await financialCopyDeleted(client, tenantId, 'salary_payment', copy.id)) {
        if (copy.source !== 'manual') immutable()
        if (copy.cash_operation_id) {
          await lockFinancialCopy(client, 'cash_operation', copy.cash_operation_id)
          if (!await financialCopyDeleted(client, tenantId, 'cash_operation', copy.cash_operation_id)) conflict()
        }
        return
      }
      // Archived staff still own their historical payroll. Identity is scoped by
      // trusted app metadata, never user-editable metadata or today's role/rate.
      const employee = await client.query(
        "SELECT id FROM auth.users WHERE id=$1 AND raw_app_meta_data->>'tenant_id'=$2",
        [copy.employee_id, tenantId],
      )
      if (!employee.rowCount) required('Спочатку потрібна копія працівника з цього магазину')
      if (copy.created_by) {
        const actor = await client.query("SELECT id FROM auth.users WHERE id=$1 AND raw_app_meta_data->>'tenant_id'=$2",
          [copy.created_by, tenantId])
        if (!actor.rowCount) required('Виконавець зарплатної операції відсутній у копії цього магазину')
      }
      if (copy.commission_source_sale_id) {
        const sale = await client.query("SELECT id FROM sales WHERE id=$1 AND tenant_id=$2 AND status IN ('completed','returned')",
          [copy.commission_source_sale_id, tenantId])
        if (!sale.rowCount) required('Спочатку потрібна копія початкового завершеного чека')
      }
      if (copy.commission_source_order_id) {
        const order = await client.query('SELECT sale_id FROM customer_orders WHERE id=$1 AND tenant_id=$2',
          [copy.commission_source_order_id, tenantId])
        if (!order.rowCount || (copy.commission_source_sale_id && order.rows[0].sale_id !== copy.commission_source_sale_id)) {
          required('Замовлення не відповідає початковому чеку зарплати')
        }
      }
      if (copy.commission_source_return_id) {
        const returned = await client.query("SELECT sale_id FROM returns WHERE id=$1 AND tenant_id=$2 AND status='completed'",
          [copy.commission_source_return_id, tenantId])
        if (!returned.rowCount || (copy.commission_source_sale_id && returned.rows[0].sale_id !== copy.commission_source_sale_id)) {
          required('Спочатку потрібна копія відповідного завершеного повернення')
        }
        if (copy.commission_source_order_id && !copy.commission_source_sale_id) {
          const order = await client.query('SELECT id FROM customer_orders WHERE id=$1 AND tenant_id=$2 AND sale_id=$3',
            [copy.commission_source_order_id, tenantId, returned.rows[0].sale_id])
          if (!order.rowCount) required('Повернення не відповідає замовленню зарплати')
        }
      }
      if (copy.shift_id) {
        const shift = await client.query('SELECT id FROM shifts WHERE id=$1 AND tenant_id=$2', [copy.shift_id, tenantId])
        if (!shift.rowCount) required('Спочатку потрібна копія початкової касової зміни')
      }
      if (copy.cash_operation_id) {
        await lockFinancialCopy(client, 'cash_operation', copy.cash_operation_id)
        if (await financialCopyDeleted(client, tenantId, 'cash_operation', copy.cash_operation_id)) conflict()
        const claimed = await client.query('SELECT id FROM salary_payments WHERE cash_operation_id=$1 AND id<>$2 LIMIT 1',
          [copy.cash_operation_id, copy.id])
        if (claimed.rowCount) conflict()
        const cash = await client.query('SELECT shift_id,type,amount FROM cash_operations WHERE id=$1 AND tenant_id=$2',
          [copy.cash_operation_id, tenantId])
        if (!cash.rowCount) required('Спочатку потрібна копія вже проведеної касової виплати')
        if (cash.rows[0].type !== 'out' || Number(cash.rows[0].amount) !== copy.amount
          || (copy.shift_id && cash.rows[0].shift_id !== copy.shift_id)) conflict()
      }
      const inserted = await client.query(
        `INSERT INTO salary_payments (
          id,tenant_id,employee_id,employee_name,amount,type,method,period,work_date,source,note,cash_operation_id,
          commission_source_sale_id,commission_source_order_id,commission_source_return_id,created_by,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT (id) DO NOTHING RETURNING id`,
        [...values(copy, tenantId), operation.applied_at ?? new Date().toISOString()],
      )
      if (!inserted.rowCount) {
        const existing = await client.query('SELECT * FROM salary_payments WHERE id=$1 FOR UPDATE', [copy.id])
        if (!existing.rowCount || JSON.stringify(storedValues(existing.rows[0])) !== JSON.stringify(values(copy, tenantId))) conflict()
      }
    })
  } catch (error) {
    // A natural-key collision is not an idempotent replay: another row would
    // have disappeared under the old blanket ON CONFLICT DO NOTHING.
    if ((error as { code?: string })?.code === '23505') conflict()
    throw error
  }
}

function immutable(): never {
  throw new AppError('SYNC_AUTOMATIC_SALARY_IMMUTABLE', 'Автоматичне нарахування зарплати не можна видалити', 409)
}

/** Copy a committed local deletion, even if its create message has not arrived.
 * New senders include the exact deleted row; old ID-only messages must wait for
 * the source copy instead of acknowledging an unknown, possibly cash-linked ID. */
export async function applySalaryPaymentDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const paymentId = operation.aggregate_id?.toLowerCase(), payload = operation.payload ?? {}
  if (operation.tenant_id !== tenantId || !isUuid(paymentId)
    || (payload.id !== undefined && (typeof payload.id !== 'string' || payload.id.toLowerCase() !== paymentId))) {
    invalid('Неузгоджений ідентифікатор видаленої виплати')
  }
  let requested: Copy | null = null
  if (payload.deleted_payment !== undefined) {
    if (!payload.deleted_payment || typeof payload.deleted_payment.created_at !== 'string') invalid('Немає первісних реквізитів видаленої виплати')
    requested = parseSalaryCopy(tenantId, { ...operation, payload: payload.deleted_payment })
    if (requested.source !== 'manual') immutable()
  }
  await runTransaction(async client => {
    await lockFinancialCopy(client, 'salary_payment', paymentId)
    const stored = await client.query('SELECT * FROM salary_payments WHERE id=$1 FOR UPDATE', [paymentId])
    const row = stored.rows[0]
    if (row && row.tenant_id !== tenantId) conflict()
    if (row && row.source !== 'manual') immutable()
    if (await financialCopyDeleted(client, tenantId, 'salary_payment', paymentId)) {
      if (row) conflict()
      return
    }
    if (row && requested && JSON.stringify(storedValues(row)) !== JSON.stringify(values(requested, tenantId))) conflict()
    if (!row && !requested) required('Для видалення потрібна копія первісної виплати. Оновіть локальну програму та повторіть передачу.')
    const copy = requested ?? parseSalaryCopy(tenantId, { ...operation, payload: {
      ...row, work_date: row.work_date instanceof Date ? row.work_date.toISOString().slice(0, 10) : row.work_date,
      created_at: new Date(row.created_at).toISOString(),
    } })
    if (copy.cash_operation_id) {
      await lockFinancialCopy(client, 'cash_operation', copy.cash_operation_id)
      const claimed = await client.query('SELECT id FROM salary_payments WHERE cash_operation_id=$1 AND id<>$2 LIMIT 1',
        [copy.cash_operation_id, paymentId])
      if (claimed.rowCount) conflict()
      const cash = await client.query('SELECT * FROM cash_operations WHERE id=$1 FOR UPDATE', [copy.cash_operation_id])
      const movement = cash.rows[0]
      if (movement && (movement.tenant_id !== tenantId || movement.type !== 'out' || Number(movement.amount) !== copy.amount
        || (copy.shift_id && movement.shift_id !== copy.shift_id)
        || (movement.employee_id && movement.employee_id !== copy.employee_id)
        || (movement.work_date && new Date(movement.work_date).toISOString().slice(0, 10) !== copy.work_date)
        || (copy.created_by && movement.created_by !== copy.created_by)
        || new Date(movement.created_at).toISOString() !== copy.created_at)) conflict()
    }
    await client.query('DELETE FROM salary_payments WHERE id=$1 AND tenant_id=$2', [paymentId, tenantId])
    if (copy.cash_operation_id) {
      await client.query('DELETE FROM cash_operations WHERE id=$1 AND tenant_id=$2', [copy.cash_operation_id, tenantId])
      await markFinancialCopyDeleted(client, tenantId, 'cash_operation', copy.cash_operation_id)
    }
    await markFinancialCopyDeleted(client, tenantId, 'salary_payment', paymentId)
  })
}
