/**
 * Винесено з `syncService.ts` без зміни поведінки — див. `REFACTOR_PLAN.md`,
 * ітерація 4. У файлі на 4900 рядків помилку не видно очима.
 */

import { runTransaction } from '../../db/pg.js'

import { AppError } from '../../middleware/errorHandler.js'
import { isUuid, uuidOr } from './syncCore.js'
import type { SyncOutboxOperation } from './syncCore.js'
import { normalizePaymentMethod } from './syncMath.js'
import { randomUUID } from 'node:crypto'

export { applyCashOperationCreated } from './cashMirror.js'

export { applyReturnCreated } from './returnMirror.js'

export async function applySuspendedSale(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const saleId = String(payload.id ?? operation.aggregate_id)
  const shiftId = String(payload.shift_id ?? '')
  const items = Array.isArray(payload.items) ? payload.items : []
  if (!isUuid(saleId) || !isUuid(shiftId) || items.length === 0) {
    throw new AppError('SYNC_SUSPENDED_SALE_INVALID', 'Некоректний відкладений чек', 400)
  }
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at

  await runTransaction(async (client) => {
    const existing = await client.query(
      'SELECT id FROM sales WHERE id = $1 AND tenant_id = $2 LIMIT 1',
      [saleId, tenantId],
    )
    if (existing.rowCount) return

    const cashierId = uuidOr(payload.cashier_id ?? payload.manager_id, userId)
    const shift = await client.query(
      'SELECT id FROM shifts WHERE id = $1 AND tenant_id = $2 LIMIT 1',
      [shiftId, tenantId],
    )
    if (!shift.rowCount) {
      await client.query(
        `INSERT INTO shifts (
          id, tenant_id, cashier_id, status, opening_cash, opened_at, notes, created_at, updated_at
        ) VALUES ($1,$2,$3,'open',0,$4,$5,$4,$6)`,
        [shiftId, tenantId, cashierId, createdAt, 'Створено під час офлайн-синхронізації', appliedAt],
      )
    }

    const subtotal = Math.max(0, Math.round(Number(payload.subtotal ?? 0)))
    const total = Math.max(0, Math.round(Number(payload.total ?? subtotal)))
    await client.query(
      `INSERT INTO sales (
        id, tenant_id, sale_number, customer_id, cashier_id, shift_id, status,
        subtotal, discount, total, payment_method, is_debt, notes, manager_id,
        cash_amount, card_amount, pickup_cell, completed_at, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,'suspended',
        $7,0,$8,$9,false,$10,$11,
        0,0,$12,$13,$13,$14
      )`,
      [
        saleId,
        tenantId,
        payload.sale_number ?? `S-${saleId.slice(0, 8)}`,
        isUuid(payload.customer_id) ? payload.customer_id : null,
        cashierId,
        shiftId,
        subtotal,
        total,
        normalizePaymentMethod(payload.payment_method),
        payload.notes ?? null,
        uuidOr(payload.manager_id, cashierId),
        payload.pickup_cell ?? null,
        createdAt,
        appliedAt,
      ],
    )

    for (const item of items) {
      const productId = String(item?.product_id ?? '')
      const qty = Number(item?.qty ?? 0)
      if (!isUuid(productId) || !Number.isFinite(qty) || qty <= 0) continue
      const product = await client.query(
        'SELECT purchase_price FROM products WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1',
        [productId, tenantId],
      )
      if (!product.rowCount) throw new AppError('SYNC_PRODUCT_NOT_FOUND', `Товар не знайдено: ${productId}`, 404)
      const unitPrice = Math.max(0, Math.round(Number(item?.unit_price ?? 0)))
      const discount = Math.max(0, Math.round(Number(item?.discount ?? 0)))
      const lineTotal = Math.max(0, Math.round(Number(item?.total ?? qty * unitPrice - discount)))
      await client.query(
        `INSERT INTO sale_items (
          id, tenant_id, sale_id, product_id, qty, unit_price, discount, total, cost_price
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          isUuid(item?.id) ? item.id : randomUUID(),
          tenantId,
          saleId,
          productId,
          qty,
          unitPrice,
          discount,
          lineTotal,
          Math.max(0, Math.round(Number(item?.purchase_price ?? product.rows[0].purchase_price ?? 0))),
        ],
      )
    }
  })
}

export async function applySuspendedSaleClosed(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  await runTransaction(async (client) => {
    await client.query(
      "UPDATE sales SET status = 'cancelled', updated_at = $3 WHERE id = $1 AND tenant_id = $2 AND status = 'suspended'",
      [operation.aggregate_id, tenantId, operation.applied_at ?? operation.created_at],
    )
  })
}

export async function applyShiftOpened(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const createdAt = payload.created_at ?? operation.created_at
  const openedAt = payload.opened_at ?? createdAt
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    const existing = await client.query(
      'SELECT id FROM shifts WHERE id = $1 AND tenant_id = $2',
      [operation.aggregate_id, tenantId],
    )
    if (existing.rowCount && existing.rowCount > 0) return

    await client.query(
      `INSERT INTO shifts (
        id, tenant_id, cashier_id, status, opening_cash, opened_at, notes, created_at, updated_at
      )
      VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8)`,
      [
        operation.aggregate_id,
        tenantId,
        payload.cashier_id,
        Number(payload.opening_cash ?? 0),
        openedAt,
        payload.notes ?? null,
        createdAt,
        appliedAt,
      ],
    )
  })
}

export async function applyShiftClosed(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const closedAt = payload.closed_at ?? payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    const result = await client.query(
      `UPDATE shifts
       SET status = 'closed', closing_cash = $3, expected_cash = $4,
           cash_variance = $5, closed_at = $6, notes = COALESCE($7, notes), updated_at = $8
       WHERE id = $1 AND tenant_id = $2`,
      [
        operation.aggregate_id,
        tenantId,
        Number(payload.closing_cash ?? 0),
        Number(payload.expected_cash ?? 0),
        Number(payload.cash_variance ?? 0),
        closedAt,
        payload.notes ?? null,
        appliedAt,
      ],
    )
    if (!result.rowCount) {
      throw new AppError('SYNC_SHIFT_NOT_FOUND', 'Зміну для закриття не знайдено', 404)
    }
  })
}

export { applySaleCompleted } from './saleMirror.js'
