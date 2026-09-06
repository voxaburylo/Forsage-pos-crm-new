/**
 * Винесено з `syncService.ts` без зміни поведінки — див. `REFACTOR_PLAN.md`,
 * ітерація 4. У файлі на 4900 рядків помилку не видно очима.
 */

import { runTransaction } from '../../db/pg.js'
import { AppError } from '../../middleware/errorHandler.js'
import { isUuid } from './syncCore.js'
import type { SyncOutboxOperation } from './syncCore.js'

export async function applyCustomerUpsert(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const incomingPayload = operation.payload ?? {}
  let payload = incomingPayload
  const customerId = String(payload.id ?? operation.aggregate_id)
  if (!isUuid(customerId)) throw new AppError('SYNC_CUSTOMER_INVALID', 'Некоректний ідентифікатор клієнта', 400)
  const timestamp = operation.applied_at ?? new Date().toISOString()
  const birthDateProvided = Object.prototype.hasOwnProperty.call(incomingPayload, 'birth_date')

  await runTransaction(async (client) => {
    const existingResult = await client.query(
      'SELECT * FROM customers WHERE id = $1 AND tenant_id = $2 LIMIT 1 FOR UPDATE',
      [customerId, tenantId],
    )
    const existing = existingResult.rows[0]
    if (existing) {
      payload = {
        ...existing,
        ...incomingPayload,
        debt_balance: existing.debt_balance,
        deposit_balance: existing.deposit_balance,
        bonus_balance: existing.bonus_balance,
      }
    }

    await client.query(
      `INSERT INTO customers (
        id, tenant_id, phone, full_name, email, debt_balance,
        deposit_balance, loyalty_mode, notes, tags, price_tier_id, bonus_balance,
        vip_level, risk_profile, discount_pct, client_status, card_barcode,
        created_at, updated_at, deleted_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,NULL
      )
      ON CONFLICT (id) DO UPDATE SET
        phone = EXCLUDED.phone,
        full_name = EXCLUDED.full_name,
        email = EXCLUDED.email,
        debt_balance = EXCLUDED.debt_balance,
        deposit_balance = EXCLUDED.deposit_balance,
        loyalty_mode = EXCLUDED.loyalty_mode,
        notes = EXCLUDED.notes,
        tags = EXCLUDED.tags,
        price_tier_id = EXCLUDED.price_tier_id,
        bonus_balance = EXCLUDED.bonus_balance,
        vip_level = EXCLUDED.vip_level,
        risk_profile = EXCLUDED.risk_profile,
        discount_pct = EXCLUDED.discount_pct,
        client_status = EXCLUDED.client_status,
        card_barcode = EXCLUDED.card_barcode,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL
      WHERE customers.tenant_id = EXCLUDED.tenant_id`,
      [
        customerId,
        tenantId,
        payload.phone?.trim() || null,
        payload.full_name?.trim() || null,
        payload.email?.trim() || null,
        Number(payload.debt_balance ?? 0),
        Number(payload.deposit_balance ?? 0),
        payload.loyalty_mode === 'cashback' ? 'cashback' : 'discount',
        payload.notes ?? null,
        Array.isArray(payload.tags) ? payload.tags : [],
        isUuid(payload.price_tier_id) ? payload.price_tier_id : null,
        Number(payload.bonus_balance ?? 0),
        payload.vip_level ?? 'standard',
        payload.risk_profile ?? 'low',
        Number(payload.discount_pct ?? 0),
        payload.client_status ?? 'client',
        payload.card_barcode?.trim() || null,
        timestamp,
      ],
    )

    if (birthDateProvided) {
      const hasBirthDate = await client.query(
        `SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'customers'
           AND column_name = 'birth_date'
         LIMIT 1`,
      )
      if (hasBirthDate.rowCount) {
        await client.query(
          'UPDATE customers SET birth_date = $3 WHERE id = $1 AND tenant_id = $2',
          [customerId, tenantId, payload.birth_date || null],
        )
      }
    }
  })
}

export async function applyCustomerDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    const customer = await client.query(
      `SELECT COALESCE(debt_balance, 0) AS debt_balance,
              COALESCE(deposit_balance, 0) AS deposit_balance,
              COALESCE(bonus_balance, 0) AS bonus_balance
       FROM customers
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       LIMIT 1 FOR UPDATE`,
      [operation.aggregate_id, tenantId],
    )
    if (!customer.rowCount) return
    const row = customer.rows[0]
    if (Number(row.debt_balance) !== 0 || Number(row.deposit_balance) !== 0 || Number(row.bonus_balance) !== 0) {
      throw new AppError('SYNC_CUSTOMER_HAS_BALANCE', 'Клієнта не можна видалити, доки є борг, передплата або бонуси', 409)
    }
    const activeOrder = await client.query(
      `SELECT 1 FROM customer_orders
       WHERE customer_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         AND status NOT IN ('completed', 'cancelled', 'canceled', 'archived')
       LIMIT 1`,
      [operation.aggregate_id, tenantId],
    )
    if (activeOrder.rowCount) {
      throw new AppError('SYNC_CUSTOMER_HAS_ACTIVE_ORDERS', 'У клієнта є незавершені замовлення або чернетки', 409)
    }
    await client.query(
      `UPDATE customer_cars
       SET deleted_at = $3, updated_at = $3
       WHERE customer_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [operation.aggregate_id, tenantId, appliedAt],
    )
    await client.query(
      'UPDATE customers SET deleted_at = $3, updated_at = $3 WHERE id = $1 AND tenant_id = $2',
      [operation.aggregate_id, tenantId, appliedAt],
    )
  })
}

export async function applyCustomerVehicleUpsert(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const vehicleId = String(payload.id ?? operation.aggregate_id)
  const customerId = String(payload.customer_id ?? '')
  if (!isUuid(vehicleId) || !isUuid(customerId)) {
    throw new AppError('SYNC_CUSTOMER_VEHICLE_INVALID', 'Некоректні дані автомобіля клієнта', 400)
  }
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    const customer = await client.query(
      'SELECT id FROM customers WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1',
      [customerId, tenantId],
    )
    if (!customer.rowCount) throw new AppError('SYNC_CUSTOMER_NOT_FOUND', 'Клієнта автомобіля не знайдено', 404)
    await client.query(
      `INSERT INTO customer_cars (
        id, tenant_id, customer_id, make, model, year, vin, notes,
        created_at, updated_at, deleted_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL)
      ON CONFLICT (id) DO UPDATE SET
        customer_id = EXCLUDED.customer_id,
        make = EXCLUDED.make,
        model = EXCLUDED.model,
        year = EXCLUDED.year,
        vin = EXCLUDED.vin,
        notes = EXCLUDED.notes,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL
      WHERE customer_cars.tenant_id = EXCLUDED.tenant_id`,
      [
        vehicleId,
        tenantId,
        customerId,
        String(payload.brand ?? payload.make ?? '').trim() || 'Авто',
        String(payload.model ?? '').trim() || '—',
        Number.isFinite(Number(payload.year)) ? Number(payload.year) : null,
        payload.vin?.trim()?.toUpperCase() || null,
        payload.notes ?? null,
        createdAt,
        appliedAt,
      ],
    )
  })
}

export async function applyCustomerVehicleDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    await client.query(
      `UPDATE customer_cars
       SET deleted_at = $3, updated_at = $3
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [operation.aggregate_id, tenantId, appliedAt],
    )
  })
}

export async function applyCustomerDebtPaid(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const customerId = String(payload.customer_id ?? operation.aggregate_id)
  const amount = Number(payload.amount ?? 0)
  const method = payload.method === 'card' || payload.method === 'transfer' ? payload.method : 'cash'
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  if (!customerId || !Number.isFinite(amount) || amount <= 0) {
    throw new AppError('SYNC_CUSTOMER_DEBT_INVALID', 'Некоректна оплата боргу', 400)
  }

  await runTransaction(async (client) => {
    const idempotencyKey = `desktop:customer.debt_paid:${operation.operation_id}`
    const claim = await client.query(
      `INSERT INTO idempotency_keys (key, tenant_id, response, created_at)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (key, tenant_id) DO NOTHING
       RETURNING key`,
      [idempotencyKey, tenantId, JSON.stringify({ operation_id: operation.operation_id }), appliedAt],
    )
    if (!claim.rowCount) return

    const customerResult = await client.query(
      'SELECT id, full_name, phone, COALESCE(debt_balance, 0) AS debt_balance FROM customers WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1 FOR UPDATE',
      [customerId, tenantId],
    )
    if (!customerResult.rowCount) throw new AppError('SYNC_CUSTOMER_NOT_FOUND', 'Клієнта не знайдено', 404)
    const customer = customerResult.rows[0]
    if (Number(customer.debt_balance ?? 0) <= 0) return
    const paid = Math.min(amount, Number(customer.debt_balance ?? 0))
    const balanceAfter = Number(customer.debt_balance ?? 0) - paid
    await client.query(
      'UPDATE customers SET debt_balance = $3, updated_at = $4 WHERE id = $1 AND tenant_id = $2',
      [customerId, tenantId, balanceAfter, appliedAt],
    )
    if (method === 'cash' && payload.shift_id) {
      const cashOperationId = isUuid(payload.cash_operation_id) ? payload.cash_operation_id : operation.operation_id
      await client.query(
        `INSERT INTO cash_operations (id, tenant_id, shift_id, type, amount, note, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, 'in', $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [cashOperationId, tenantId, payload.shift_id, paid, payload.notes ?? (`Оплата боргу: ${customer.full_name ?? customer.phone ?? customerId.slice(0, 8)}`), payload.created_by ?? userId, createdAt, appliedAt],
      )
    }
  })
}

export async function applyCustomerDepositChanged(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const customerId = String(payload.customer_id ?? operation.aggregate_id)
  const transactionId = String(payload.transaction_id ?? operation.operation_id)
  const amount = Number(payload.amount ?? 0)
  const method = payload.method === 'card' || payload.method === 'transfer' || payload.method === 'account' || payload.method === 'correction' || payload.method === 'cashback'
    ? payload.method
    : 'cash'
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  if (!customerId || !transactionId || !Number.isFinite(amount) || amount === 0) {
    throw new AppError('SYNC_CUSTOMER_DEPOSIT_INVALID', 'Некоректний рух рахунку клієнта', 400)
  }

  await runTransaction(async (client) => {
    const existing = await client.query('SELECT id, tenant_id FROM customer_deposit_transactions WHERE id = $1 LIMIT 1', [transactionId])
    if (existing.rowCount && existing.rowCount > 0) {
      if (existing.rows[0].tenant_id !== tenantId) {
        throw new AppError('SYNC_DEPOSIT_TENANT_CONFLICT', 'Операція рахунку належить іншому магазину', 409)
      }
      return
    }

    const customerResult = await client.query(
      'SELECT id, full_name, phone, COALESCE(deposit_balance, 0) AS deposit_balance FROM customers WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1 FOR UPDATE',
      [customerId, tenantId],
    )
    if (!customerResult.rowCount) throw new AppError('SYNC_CUSTOMER_NOT_FOUND', 'Клієнта не знайдено', 404)
    const customer = customerResult.rows[0]
    const balanceAfter = Number(customer.deposit_balance ?? 0) + amount
    if (balanceAfter < 0) throw new AppError('INSUFFICIENT_DEPOSIT', 'Недостатньо коштів на рахунку клієнта', 400)

    await client.query(
      'UPDATE customers SET deposit_balance = $3, updated_at = $4 WHERE id = $1 AND tenant_id = $2',
      [customerId, tenantId, balanceAfter, appliedAt],
    )
    await client.query(
      `INSERT INTO customer_deposit_transactions (
        id, tenant_id, customer_id, amount, balance_after, method, order_id, sale_id,
        shift_id, notes, created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [transactionId, tenantId, customerId, amount, balanceAfter, method, payload.order_id ?? null, payload.sale_id ?? null, payload.shift_id ?? null, payload.notes ?? null, payload.created_by ?? userId, createdAt, appliedAt],
    )

    if (method === 'cash' && payload.shift_id) {
      const cashOperationId = isUuid(payload.cash_operation_id) ? payload.cash_operation_id : operation.operation_id
      const cashType = amount < 0 ? 'out' : 'in'
      const cashNote = payload.notes ?? (amount < 0
        ? `Видача з рахунку клієнта: ${customer.full_name ?? customer.phone ?? customerId.slice(0, 8)}`
        : `Поповнення рахунку клієнта: ${customer.full_name ?? customer.phone ?? customerId.slice(0, 8)}`)
      await client.query(
        `INSERT INTO cash_operations (id, tenant_id, shift_id, type, amount, note, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [cashOperationId, tenantId, payload.shift_id, cashType, Math.abs(amount), cashNote, payload.created_by ?? userId, createdAt, appliedAt],
      )
    }
  })
}

export async function applyCustomerBonusAdjusted(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const customerId = String(payload.customer_id ?? operation.aggregate_id)
  const transactionId = String(payload.transaction_id ?? operation.operation_id)
  const amount = Number(payload.amount ?? 0)
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  if (!isUuid(customerId) || !isUuid(transactionId) || !Number.isFinite(amount) || amount === 0) {
    throw new AppError('SYNC_CUSTOMER_BONUS_INVALID', 'Некоректна зміна бонусів клієнта', 400)
  }

  await runTransaction(async (client) => {
    const existing = await client.query('SELECT id, tenant_id FROM bonus_transactions WHERE id = $1 LIMIT 1', [transactionId])
    if (existing.rowCount && existing.rowCount > 0) {
      if (existing.rows[0].tenant_id !== tenantId) {
        throw new AppError('SYNC_BONUS_TENANT_CONFLICT', 'Бонусна операція належить іншому магазину', 409)
      }
      return
    }

    const updated = await client.query(
      `UPDATE customers
       SET bonus_balance = COALESCE(bonus_balance, 0) + $1, updated_at = $2
       WHERE id = $3 AND tenant_id = $4 AND deleted_at IS NULL
         AND COALESCE(bonus_balance, 0) + $1 >= 0
       RETURNING bonus_balance`,
      [amount, appliedAt, customerId, tenantId],
    )
    if (!updated.rowCount) {
      throw new AppError('SYNC_CUSTOMER_BONUS_REJECTED', 'Клієнта не знайдено або недостатньо бонусів', 409)
    }
    await client.query(
      `INSERT INTO bonus_transactions (
        id, tenant_id, customer_id, amount, transaction_type, description, created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'manual', $5, $6, $7, $8)`,
      [transactionId, tenantId, customerId, amount, payload.description ?? (amount > 0 ? 'Ручне нарахування' : 'Ручне списання'), payload.created_by ?? userId, createdAt, appliedAt],
    )
  })
}
