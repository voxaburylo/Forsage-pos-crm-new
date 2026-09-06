/**
 * Винесено з `syncService.ts` без зміни поведінки — див. `REFACTOR_PLAN.md`,
 * ітерація 4. У файлі на 4900 рядків помилку не видно очима.
 */

import { runTransaction } from '../../db/pg.js'
import { AppError } from '../../middleware/errorHandler.js'
import { isUuid } from './syncCore.js'
import type { SyncOutboxOperation } from './syncCore.js'
import { randomUUID } from 'node:crypto'

export async function applyReserveCreated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const id = String(payload.id ?? operation.aggregate_id)
  const qty = Number(payload.qty ?? 0)
  if (!isUuid(id) || !isUuid(payload.product_id) || !Number.isFinite(qty) || qty <= 0) {
    throw new AppError('SYNC_RESERVE_INVALID', 'Некоректний резерв товару', 400)
  }
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    await client.query(
      `INSERT INTO inventory_reserves (
        id, tenant_id, product_id, order_id, customer_id, qty, reserved_by,
        expires_at, released_at, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10)
      ON CONFLICT (id) DO NOTHING`,
      [
        id,
        tenantId,
        payload.product_id,
        isUuid(payload.order_id) ? payload.order_id : null,
        isUuid(payload.customer_id) ? payload.customer_id : null,
        qty,
        userId,
        payload.expires_at ?? null,
        createdAt,
        appliedAt,
      ],
    )
  })
}

export async function applyReserveReleased(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const releasedAt = operation.payload?.released_at ?? operation.payload?.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    await client.query(
      `UPDATE inventory_reserves
       SET released_at = $3, updated_at = $4
       WHERE id = $1 AND tenant_id = $2 AND released_at IS NULL`,
      [operation.aggregate_id, tenantId, releasedAt, appliedAt],
    )
  })
}

export async function applyWarehouseMovementCreated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const id = String(payload.id ?? operation.aggregate_id)
  const qty = Number(payload.qty ?? 0)
  const toBin = String(payload.to_bin ?? '').trim()
  if (!isUuid(id) || !isUuid(payload.product_id) || qty <= 0 || !toBin) {
    throw new AppError('SYNC_WAREHOUSE_MOVEMENT_INVALID', 'Некоректне переміщення товару', 400)
  }
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    const existing = await client.query('SELECT id FROM warehouse_movements WHERE id = $1 AND tenant_id = $2', [id, tenantId])
    if (existing.rowCount) return
    const product = await client.query(
      'SELECT id, storage_bin FROM products WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE',
      [payload.product_id, tenantId],
    )
    if (!product.rowCount) throw new AppError('SYNC_PRODUCT_NOT_FOUND', 'Товар переміщення не знайдено', 404)
    await client.query(
      `INSERT INTO warehouse_movements (
        id, tenant_id, product_id, from_bin, to_bin, qty, moved_by, note, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id, tenantId, payload.product_id, payload.from_bin ?? product.rows[0]?.storage_bin ?? null,
        toBin, qty, userId, payload.note ?? null, createdAt, appliedAt,
      ],
    )
    await client.query(
      'UPDATE products SET storage_bin = $3, updated_at = $4 WHERE id = $1 AND tenant_id = $2',
      [payload.product_id, tenantId, toBin, appliedAt],
    )
  })
}

export async function applyWriteoffCreated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const writeoffId = String(payload.id ?? operation.aggregate_id)
  const items = Array.isArray(payload.items) ? payload.items : []
  if (!isUuid(writeoffId) || items.length === 0) throw new AppError('SYNC_WRITEOFF_INVALID', 'Некоректне списання', 400)
  if (items.some((item: any) => !isUuid(item?.product_id) || !Number.isFinite(Number(item?.qty)) || Number(item.qty) <= 0)) {
    throw new AppError('SYNC_WRITEOFF_INVALID', 'Некоректна позиція списання', 422)
  }
  if (new Set(items.map((item: any) => item.product_id)).size !== items.length) {
    throw new AppError('SYNC_WRITEOFF_DUPLICATE', 'Один товар не можна списувати двома рядками', 422)
  }
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    const claim = await client.query(
      `INSERT INTO inventory_writeoffs (id, tenant_id, reason, notes, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [writeoffId, tenantId, payload.reason ?? 'other', payload.notes ?? null, userId, createdAt, appliedAt],
    )
    if (!claim.rowCount) {
      const existing = await client.query(
        'SELECT id FROM inventory_writeoffs WHERE id = $1 AND tenant_id = $2',
        [writeoffId, tenantId],
      )
      if (existing.rowCount) return
      throw new AppError('SYNC_WRITEOFF_TENANT_CONFLICT', 'Акт списання належить іншому магазину', 409)
    }
    await client.query(`SELECT set_config('app.stock_source_type', 'writeoff', true)`)
    await client.query(`SELECT set_config('app.stock_source_id', $1, true)`, [writeoffId])
    for (const item of items) {
      const product = await client.query(
        `SELECT purchase_price, COALESCE(qty_on_hand, 0) AS qty_on_hand
         FROM products
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [item.product_id, tenantId],
      )
      if (!product.rowCount) throw new AppError('SYNC_PRODUCT_NOT_FOUND', 'Товар списання не знайдено', 404)
      const qty = Number(item.qty)
      const available = Number(product.rows[0]?.qty_on_hand ?? 0)
      if (qty > available) {
        throw new AppError('INSUFFICIENT_STOCK', `Недостатньо товару для списання: є ${available}, потрібно ${qty}`, 409)
      }
      await client.query(
        `INSERT INTO inventory_writeoff_items (
          id, writeoff_id, product_id, qty, cost_kopecks, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), writeoffId, item.product_id, qty, Math.round(Number(product.rows[0]?.purchase_price ?? 0) * qty), createdAt],
      )
      await client.query(
        `UPDATE products
         SET qty_on_hand = qty_on_hand - $1, updated_at = $2
         WHERE id = $3 AND tenant_id = $4`,
        [qty, appliedAt, item.product_id, tenantId],
      )
    }
  })
}

export async function applyInventoryCreated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const sessionId = String(payload.id ?? operation.aggregate_id)
  if (!isUuid(sessionId)) throw new AppError('SYNC_INVENTORY_INVALID', 'Некоректна ревізія', 400)
  const name = String(payload.name ?? `Локальна ревізія ${sessionId.slice(0, 8)}`).trim().slice(0, 200)
    || 'Локальна ревізія'
  const createdBy = isUuid(payload.created_by) ? payload.created_by : userId
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at

  await runTransaction(async (client) => {
    const tombstone = await client.query(
      `SELECT 1 FROM sync_deletions
       WHERE tenant_id = $1 AND entity_type = 'inventory_session' AND entity_id = $2
       LIMIT 1`,
      [tenantId, sessionId],
    )
    if (tombstone.rowCount) return
    await client.query(
      `INSERT INTO inventory_sessions (id, tenant_id, name, status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, 'draft', $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [sessionId, tenantId, name, createdBy, createdAt, appliedAt],
    )
    const session = await client.query(
      'SELECT tenant_id FROM inventory_sessions WHERE id = $1 LIMIT 1',
      [sessionId],
    )
    if (!session.rowCount || session.rows[0].tenant_id !== tenantId) {
      throw new AppError('SYNC_INVENTORY_TENANT_CONFLICT', 'Ревізія належить іншому магазину', 409)
    }
  })
}

export async function applyInventoryStarted(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const sessionId = String(payload.id ?? operation.aggregate_id)
  if (!isUuid(sessionId)) throw new AppError('SYNC_INVENTORY_INVALID', 'Некоректна ревізія', 400)
  const startedBy = isUuid(payload.started_by) ? payload.started_by : userId
  const startedAt = payload.started_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at

  await runTransaction(async (client) => {
    const session = await client.query(
      'SELECT status FROM inventory_sessions WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [sessionId, tenantId],
    )
    if (!session.rowCount) {
      const tombstone = await client.query(
        `SELECT 1 FROM sync_deletions
         WHERE tenant_id = $1 AND entity_type = 'inventory_session' AND entity_id = $2
         LIMIT 1`,
        [tenantId, sessionId],
      )
      if (tombstone.rowCount) return
      throw new AppError('SYNC_INVENTORY_NOT_FOUND', 'Ревізію не знайдено', 404)
    }
    if (session.rows[0].status === 'completed') return
    await client.query(
      `UPDATE inventory_sessions
       SET status = 'in_progress', started_by = COALESCE(started_by, $3),
           started_at = COALESCE(started_at, $4), updated_at = $5
       WHERE id = $1 AND tenant_id = $2`,
      [sessionId, tenantId, startedBy, startedAt, appliedAt],
    )
  })
}

export async function applyInventoryDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const sessionId = String(operation.payload?.id ?? operation.aggregate_id)
  if (!isUuid(sessionId)) throw new AppError('SYNC_INVENTORY_INVALID', 'Некоректна ревізія', 400)

  await runTransaction(async (client) => {
    const session = await client.query(
      'SELECT status FROM inventory_sessions WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [sessionId, tenantId],
    )
    if (session.rows[0]?.status === 'completed') {
      throw new AppError('INVENTORY_COMPLETED', 'Завершену ревізію видаляти не можна', 400)
    }
    if (session.rowCount) {
      const content = await client.query(
        `SELECT
           EXISTS(SELECT 1 FROM inventory_items WHERE session_id = $1 AND was_counted = true) AS counted,
           EXISTS(SELECT 1 FROM inventory_count_entries WHERE session_id = $1) AS entries`,
        [sessionId],
      )
      if (content.rows[0]?.counted || content.rows[0]?.entries) {
        throw new AppError('INVENTORY_NOT_EMPTY', 'Видаляти можна тільки порожні незавершені ревізії', 400)
      }
      await client.query('DELETE FROM inventory_sessions WHERE id = $1 AND tenant_id = $2', [sessionId, tenantId])
    }
    await client.query(
      `INSERT INTO sync_deletions (tenant_id, entity_type, entity_id, deleted_at)
       VALUES ($1, 'inventory_session', $2, clock_timestamp())
       ON CONFLICT (tenant_id, entity_type, entity_id)
       DO UPDATE SET deleted_at = EXCLUDED.deleted_at`,
      [tenantId, sessionId],
    )
  })
}

export async function applyInventoryCompleted(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  // A historical document copy must never reapply an old physical count.
  const documentOnly = operation.operation_type === 'inventory.document_copied'
  const payload = operation.payload ?? {}
  const sessionId = String(payload.id ?? operation.aggregate_id)
  const items = (Array.isArray(payload.items) ? payload.items : [])
    .filter((item: any) => {
      const raw = item?.counted_stock
      const countedStock = Number(raw)
      return Boolean(item?.product_id) && raw !== null && raw !== undefined
        && typeof raw !== 'boolean' && String(raw).trim() !== ''
        && Number.isFinite(countedStock) && countedStock >= 0
    })
  if (items.length === 0) {
    throw new AppError('SYNC_INVENTORY_EMPTY', 'Неможливо завершити порожню ревізію', 422)
  }
  if (items.length !== payload.items.length || new Set(items.map((item: any) => item.product_id)).size !== items.length) {
    throw new AppError('SYNC_INVENTORY_INVALID_ITEMS', 'Ревізія містить некоректні або повторні товари', 422)
  }
  const createdBy = payload.created_by ?? userId
  const createdAt = payload.created_at ?? operation.created_at
  const completedAt = payload.completed_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  const name = String(payload.name ?? `Локальна ревізія ${sessionId.slice(0, 8)}`).trim() || 'Локальна ревізія'

  await runTransaction(async (client) => {
    await client.query(
      `INSERT INTO inventory_sessions (
        id, tenant_id, name, status, created_by, started_by, started_at, completed_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, 'in_progress', $4, $4, $5, NULL, $5, $6
      )
      ON CONFLICT (id) DO NOTHING`,
      [sessionId, tenantId, name, createdBy, createdAt, appliedAt],
    )
    const sessionState = await client.query(
      'SELECT status FROM inventory_sessions WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [sessionId, tenantId],
    )
    if (!sessionState.rowCount) {
      throw new AppError('SYNC_INVENTORY_TENANT_CONFLICT', 'Ревізія належить іншому магазину', 409)
    }
    if (sessionState.rows[0]?.status === 'completed') return
    await client.query(`SELECT set_config('app.stock_source_type', 'inventory', true)`)
    await client.query(`SELECT set_config('app.stock_source_id', $1, true)`, [sessionId])

    const touchedProductIds: string[] = []
    for (const item of items) {
      const productId = String(item?.product_id ?? '')
      if (!productId) continue
      const countedStock = Number(item?.counted_stock ?? 0)
      if (!Number.isFinite(countedStock) || countedStock < 0) continue

      const product = await client.query(
        'SELECT id, COALESCE(qty_on_hand, 0) AS qty_on_hand, updated_at FROM products WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1 FOR UPDATE',
        [productId, tenantId],
      )
      if (!product.rowCount) {
        throw new AppError('SYNC_PRODUCT_NOT_FOUND', `Товар ревізії не знайдено: ${productId}`, 404)
      }

      const expectedStock = Number(item?.expected_stock)
      const serverStock = Number(product.rows[0].qty_on_hand ?? 0)
      if (!Number.isFinite(expectedStock)) {
        throw new AppError('SYNC_INVENTORY_BASE_MISSING', 'Стара ревізія не містить базового залишку. Відкрийте її та перерахуйте товар.', 409)
      }
      if (!documentOnly && serverStock !== expectedStock && serverStock !== countedStock) {
        throw new AppError('SYNC_INVENTORY_CONFLICT', 'Залишок товару змінився після початку ревізії: було ' + expectedStock + ', зараз ' + serverStock + '. Оновіть ревізію і перерахуйте позицію.', 409)
      }

      const itemResult = await client.query(
        `INSERT INTO inventory_items (
          session_id, product_id, expected_stock, counted_stock, was_counted,
          price_checked, last_counted_by, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, true, true, $5, $6, $7
        )
        ON CONFLICT (session_id, product_id) DO UPDATE SET
          counted_stock = EXCLUDED.counted_stock,
          was_counted = true,
          price_checked = true,
          last_counted_by = EXCLUDED.last_counted_by,
          updated_at = EXCLUDED.updated_at
        RETURNING id`,
        [sessionId, productId, expectedStock, countedStock, createdBy, completedAt, appliedAt],
      )

      const inventoryItemId = itemResult.rows[0]?.id
      if (inventoryItemId) {
        await client.query(
          `INSERT INTO inventory_count_entries (
            id, tenant_id, session_id, inventory_item_id, product_id, counted_by,
            qty, price_checked, observed_retail_price, created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, true, NULL, $8
          )`,
          [randomUUID(), tenantId, sessionId, inventoryItemId, productId, createdBy, countedStock, completedAt],
        )
      }

      if (!documentOnly) {
        await client.query(
          'UPDATE products SET qty_on_hand = $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4',
          [countedStock, appliedAt, productId, tenantId],
        )
        touchedProductIds.push(productId)
      }
    }
    if (touchedProductIds.length > 0) {
      await client.query(
        'UPDATE products SET updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
        [tenantId, [...new Set(touchedProductIds)]],
      )
      await client.query(
        'UPDATE inventory_items SET updated_at = clock_timestamp() WHERE session_id = $1',
        [sessionId],
      )
    }
    await client.query(
      `UPDATE inventory_sessions
       SET status = 'completed', completed_at = $3, name = $4, updated_at = $5
       WHERE id = $1 AND tenant_id = $2`,
      [sessionId, tenantId, completedAt, name, appliedAt],
    )
  })
}
