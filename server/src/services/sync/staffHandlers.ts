/**
 * Винесено з `syncService.ts` без зміни поведінки — див. `REFACTOR_PLAN.md`,
 * ітерація 4. У файлі на 4900 рядків помилку не видно очима.
 */

import { runTransaction } from '../../db/pg.js'
import { supabaseAdmin } from '../../db/supabaseAdmin.js'
import { isSupportedSecretHash, secretHashNeedsUpgrade } from '../../lib/secretHash.js'
import { AppError } from '../../middleware/errorHandler.js'
import { isUuid, normalizedPhoneEmail, uuidOr } from './syncCore.js'
import type { SyncOutboxOperation } from './syncCore.js'
import { randomUUID } from 'node:crypto'

export async function applyStaffPinUpdated(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const userId = String(payload.user_id ?? operation.aggregate_id)
  const pinHash = String(payload.pin_hash ?? '')
  if (!isUuid(userId) || !isSupportedSecretHash(pinHash) || secretHashNeedsUpgrade(pinHash)) {
    throw new AppError('SYNC_STAFF_PIN_INVALID', 'Некоректний захищений PIN співробітника', 400)
  }

  const { data: existing, error } = await supabaseAdmin.auth.admin.getUserById(userId)
  if (error || !existing.user) throw new AppError('SYNC_STAFF_NOT_FOUND', 'Співробітника не знайдено', 404)
  if (existing.user.app_metadata?.tenant_id !== tenantId) {
    throw new AppError('SYNC_TENANT_MISMATCH', 'Співробітник належить іншому магазину', 403)
  }

  await runTransaction(async (client) => {
    await client.query(
      `INSERT INTO staff_pins (user_id, pin_code, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET
         pin_code = EXCLUDED.pin_code,
         updated_at = EXCLUDED.updated_at`,
      [userId, pinHash, payload.updated_at ?? operation.created_at],
    )
  })
}

export async function applyStaffUserUpsert(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const userId = String(payload.id ?? operation.aggregate_id)
  if (!isUuid(userId)) throw new AppError('SYNC_STAFF_INVALID', 'Некоректний ідентифікатор співробітника', 400)

  const { data: existing, error: readError } = await supabaseAdmin.auth.admin.getUserById(userId)
  if (readError && !/not found/i.test(readError.message)) throw new AppError('AUTH_ERROR', readError.message, 500)
  if (existing.user) {
    if (existing.user.app_metadata?.tenant_id !== tenantId) {
      throw new AppError('SYNC_TENANT_MISMATCH', 'Співробітник належить іншому магазину', 403)
    }
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      email: normalizedPhoneEmail(payload.phone),
      user_metadata: {
        ...existing.user.user_metadata,
        phone: payload.phone ?? null,
        full_name: payload.full_name ?? '',
      },
      app_metadata: {
        ...existing.user.app_metadata,
        tenant_id: tenantId,
        role: payload.role ?? 'cashier',
        is_active: payload.is_active !== false,
        base_rate: Number(payload.base_rate ?? 0),
        rate_period: payload.rate_period === 'month' ? 'month' : 'day',
      },
    })
    if (error) throw new AppError('AUTH_ERROR', error.message, 500)
    return
  }

  const { error } = await supabaseAdmin.auth.admin.createUser({
    id: userId,
    email: normalizedPhoneEmail(payload.phone),
    password: `${randomUUID()}-${randomUUID()}`,
    email_confirm: true,
    user_metadata: {
      phone: payload.phone ?? null,
      full_name: payload.full_name ?? '',
    },
    app_metadata: {
      tenant_id: tenantId,
      role: payload.role ?? 'cashier',
      is_active: payload.is_active !== false,
      base_rate: Number(payload.base_rate ?? 0),
      rate_period: payload.rate_period === 'month' ? 'month' : 'day',
    },
  } as any)
  if (error) throw new AppError('AUTH_ERROR', error.message, 500)
}

export async function applyStaffUserDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const { data: existing, error: readError } = await supabaseAdmin.auth.admin.getUserById(operation.aggregate_id)
  if (readError && /not found/i.test(readError.message)) return
  if (readError) throw new AppError('AUTH_ERROR', readError.message, 500)
  if (!existing.user || existing.user.app_metadata?.tenant_id !== tenantId) return
  const { error } = await supabaseAdmin.auth.admin.updateUserById(operation.aggregate_id, {
    app_metadata: { ...existing.user.app_metadata, is_active: false },
  })
  if (error) throw new AppError('AUTH_ERROR', error.message, 500)
}

export async function applyCommissionRuleCreated(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const id = String(payload.id ?? operation.aggregate_id)
  if (!isUuid(id)) throw new AppError('SYNC_COMMISSION_INVALID', 'Некоректне правило комісії', 400)
  await runTransaction(async (client) => {
    await client.query(
      `INSERT INTO commission_rules (
        id, tenant_id, user_id, brand_id, category_id, pct_from_revenue,
        pct_from_profit, rule_type, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
      ON CONFLICT (id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        brand_id = EXCLUDED.brand_id,
        category_id = EXCLUDED.category_id,
        pct_from_revenue = EXCLUDED.pct_from_revenue,
        pct_from_profit = EXCLUDED.pct_from_profit,
        rule_type = EXCLUDED.rule_type,
        updated_at = EXCLUDED.updated_at
      WHERE commission_rules.tenant_id = EXCLUDED.tenant_id`,
      [
        id,
        tenantId,
        isUuid(payload.user_id) ? payload.user_id : null,
        isUuid(payload.brand_id) ? payload.brand_id : null,
        isUuid(payload.category_id) ? payload.category_id : null,
        Number(payload.pct_from_revenue ?? 0),
        Number(payload.pct_from_profit ?? 0),
        payload.rule_type ?? 'personal_sales',
        operation.created_at,
      ],
    )
  })
}

export async function applyCommissionRuleDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  await runTransaction(async (client) => {
    await client.query('DELETE FROM commission_rules WHERE id = $1 AND tenant_id = $2', [operation.aggregate_id, tenantId])
  })
}

export async function applySalaryPaymentCreated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const id = String(payload.id ?? operation.aggregate_id)
  if (!isUuid(id) || !isUuid(payload.employee_id)) {
    throw new AppError('SYNC_SALARY_INVALID', 'Некоректне нарахування зарплати', 400)
  }
  const source = String(payload.source ?? 'manual')
  const rawAmount = Math.round(Number(payload.amount ?? 0))
  if (!Number.isFinite(rawAmount) || rawAmount === 0 || (source === 'commission_reversal' ? rawAmount >= 0 : rawAmount < 0)) {
    throw new AppError('SYNC_SALARY_AMOUNT_INVALID', 'Некоректна сума нарахування зарплати', 400)
  }
  const amount = rawAmount
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    await client.query(
      `INSERT INTO salary_payments (
        id, tenant_id, employee_id, employee_name, amount, type, method, period,
        work_date, source, note, cash_operation_id, commission_source_sale_id,
        commission_source_order_id, commission_source_return_id, created_by, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT DO NOTHING`,
      [
        id,
        tenantId,
        payload.employee_id,
        payload.employee_name ?? 'Співробітник',
        amount,
        payload.type ?? 'salary',
        payload.method ?? 'cash',
        payload.period ?? String(createdAt).slice(0, 7),
        payload.work_date ?? String(createdAt).slice(0, 10),
        source,
        payload.note ?? null,
        isUuid(payload.cash_operation_id) ? payload.cash_operation_id : null,
        isUuid(payload.commission_source_sale_id) ? payload.commission_source_sale_id : null,
        isUuid(payload.commission_source_order_id) ? payload.commission_source_order_id : null,
        isUuid(payload.commission_source_return_id) ? payload.commission_source_return_id : null,
        uuidOr(payload.created_by, userId),
        createdAt,
        appliedAt,
      ],
    )
  })
}

export async function applySalaryPaymentDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  await runTransaction(async (client) => {
    const payment = await client.query(
      'SELECT cash_operation_id, source FROM salary_payments WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [operation.aggregate_id, tenantId],
    )
    if (!payment.rowCount) return
    if (payment.rows[0].source !== 'manual') {
      throw new AppError('SYNC_AUTOMATIC_SALARY_IMMUTABLE', 'Автоматичне нарахування зарплати не можна видалити', 409)
    }
    const cashOperationId = payment.rows[0]?.cash_operation_id
    await client.query('DELETE FROM salary_payments WHERE id = $1 AND tenant_id = $2', [operation.aggregate_id, tenantId])
    if (cashOperationId) {
      await client.query('DELETE FROM cash_operations WHERE id = $1 AND tenant_id = $2', [cashOperationId, tenantId])
    }
    await client.query(
      `INSERT INTO sync_deletions (tenant_id, entity_type, entity_id, deleted_at)
       VALUES ($1, 'salary_payment', $2, clock_timestamp())
       ON CONFLICT (tenant_id, entity_type, entity_id)
       DO UPDATE SET deleted_at = EXCLUDED.deleted_at`,
      [tenantId, operation.aggregate_id],
    )
    if (cashOperationId) {
      await client.query(
        `INSERT INTO sync_deletions (tenant_id, entity_type, entity_id, deleted_at)
         VALUES ($1, 'cash_operation', $2, clock_timestamp())
         ON CONFLICT (tenant_id, entity_type, entity_id)
         DO UPDATE SET deleted_at = EXCLUDED.deleted_at`,
        [tenantId, cashOperationId],
      )
    }
  })
}
