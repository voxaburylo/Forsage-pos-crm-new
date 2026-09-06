import { randomUUID } from 'node:crypto'
import { db } from '../db/supabase.js'
import { runTransaction } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'
import { clearCatalogReferenceCaches } from './adminService.js'
import {
  applySupplierCatalogImported,
  applySupplierCatalogItemDeleted,
  applySupplierCatalogItemUpsert,
} from './supplierCatalogSyncService.js'
import { nextSettingsRowUpdatedAt, prepareLabelSettingsUpdate } from './labelSettingsConflict.js'
import { clearProductSearchCache } from './productService.js'
import { processSyncBatch } from './syncBatch.js'
import { withTenantSyncGenerationGuard } from './syncGeneration.js'

// Фільтр .in() їде в URL: 1000 UUID — це ~37 000 символів, і сервер відхиляє
// такий запит як Bad Request (уся синхронізація падала з DB_ERROR). Ліміт на
// сторінку вибірки тут не годиться — потрібен окремий, менший крок.
// Спільна основа переїхала в ./sync/syncCore.ts — див. коментар там.
export type { SyncChangesInput, SyncOutboxOperation, SyncPushResult } from './sync/syncCore.js'
import {
  captureDatabaseAppliedAt,
  isUuid,
  pickShopSettingsPayload,
  assertSyncOperationAllowed,
} from './sync/syncCore.js'
import type { SyncOutboxOperation, SyncPushResult } from './sync/syncCore.js'
import { applyStaffPinUpdated, applyStaffUserUpsert, applyStaffUserDeleted, applyCommissionRuleCreated, applyCommissionRuleDeleted, applySalaryPaymentCreated, applySalaryPaymentDeleted } from './sync/staffHandlers.js'
import { applyCustomerUpsert, applyCustomerDeleted, applyCustomerVehicleUpsert, applyCustomerVehicleDeleted, applyCustomerDebtPaid, applyCustomerDepositChanged, applyCustomerBonusAdjusted } from './sync/customerHandlers.js'
import { applySupplierUpsert, applySupplierDeleted, applySupplierMerged, applySupplierInvoiceCreated, applySupplierInvoiceUpdated, applySupplierInvoicePosted, applySupplierInvoicePaymentAdded, applySupplierInvoiceCancelled, applySupplierInvoiceDeleted } from './sync/supplierHandlers.js'
import { applyInventoryCreated, applyInventoryStarted, applyInventoryDeleted, applyInventoryCompleted, applyReserveCreated, applyReserveReleased, applyWarehouseMovementCreated, applyWriteoffCreated } from './sync/inventoryHandlers.js'
import { applyCategoryUpsert, applyCategoryDeleted, applyBrandUpsert, applyBrandDeleted, applyProductUpsert, applyProductDeleted } from './sync/catalogHandlers.js'
import { applyOrderUpsert, applyOrderDeleted, applyOrderStatusUpdated, applyOrderItemStatusUpdated, applyOrderItemsArrived, applyOrderCanceled, applyOrderPaymentAdded, applyOrderCompleted } from './sync/orderHandlers.js'
import { applyShiftOpened, applyShiftClosed, applySaleCompleted, applyReturnCreated, applySuspendedSale, applySuspendedSaleClosed, applyCashOperationCreated } from './sync/salesHandlers.js'
// Читання (pull) живе в ./sync/pullService.ts; лишаємо адресу тут, щоб
// маршрути й далі брали його зі знайомого місця.
export { getSyncChanges, getBootstrapSnapshot } from './sync/pullService.js'
export async function pushLocalOperations(params: {
  tenantId: string
  userId: string
  role: string
  resetGeneration: number
  operations: SyncOutboxOperation[]
}): Promise<{
  results: SyncPushResult[]
  reset_required: boolean
  reset_generation: number
  reset_at: string | null
}> {
  const guarded = await withTenantSyncGenerationGuard(
    params.tenantId,
    params.resetGeneration,
    async () => processSyncBatch(params.operations, async (operation) => {
      if (operation.tenant_id !== params.tenantId) {
        throw new AppError('SYNC_TENANT_MISMATCH', 'Операція належить іншому магазину', 403)
      }

      assertSyncOperationAllowed(params.role, operation.operation_type)
      const restrictedCustomerWrite = ['customer.created', 'customer.updated'].includes(operation.operation_type)
        && !['owner', 'admin', 'manager'].includes(params.role)
      const rawPayload = { ...(operation.payload ?? {}) }
      const originalPayload = restrictedCustomerWrite
        ? Object.fromEntries(Object.entries(rawPayload).filter(([key]) => [
            'id', 'phone', 'full_name', 'email', 'notes', 'card_barcode', 'birth_date', 'created_at',
          ].includes(key)))
        : rawPayload
      if (originalPayload.created_at === undefined) originalPayload.created_at = operation.created_at
      // Read DB time immediately before this operation. A single batch timestamp
      // can fall behind a cursor while later independent transactions are waiting.
      const appliedAt = await captureDatabaseAppliedAt()
      const operationForApply: SyncOutboxOperation = {
        ...operation,
        created_at: appliedAt,
        applied_at: appliedAt,
        payload: originalPayload,
      }

      await applyLocalOperation({
        tenantId: params.tenantId,
        userId: params.userId,
        role: params.role,
        operation: operationForApply,
      })
    }),
  )

  if (!guarded.matched) {
    const results = params.operations.map<SyncPushResult>((operation) => {
      if (operation.tenant_id !== params.tenantId) {
        return {
          sequence: operation.sequence,
          operation_id: operation.operation_id,
          aggregate_id: operation.aggregate_id,
          status: 'failed',
          error: 'Операція належить іншому магазину',
        }
      }
      return {
        sequence: operation.sequence,
        operation_id: operation.operation_id,
        aggregate_id: operation.aggregate_id,
        status: 'discarded',
        error_code: 'SYNC_RESET_REQUIRED',
        error: 'Локальна копія належить іншому поколінню даних; потрібно виконати повне оновлення',
        reset_generation: guarded.state.generation,
        reset_at: guarded.state.resetAt ?? undefined,
      }
    }).sort((left, right) => left.sequence - right.sequence)
    return {
      results,
      reset_required: true,
      reset_generation: guarded.state.generation,
      reset_at: guarded.state.resetAt,
    }
  }

  return {
    results: (guarded.value as SyncPushResult[]).sort((left, right) => left.sequence - right.sequence),
    reset_required: false,
    reset_generation: guarded.state.generation,
    reset_at: guarded.state.resetAt,
  }
}
async function applyLocalOperation(params: {
  tenantId: string
  userId: string
  role: string
  operation: SyncOutboxOperation
}): Promise<void> {
  const { operation, tenantId, userId, role } = params

  if (operation.operation_type === 'shift.opened') {
    await applyShiftOpened(tenantId, operation)
    return
  }

  if (operation.operation_type === 'shift.closed') {
    await applyShiftClosed(tenantId, operation)
    return
  }

  if (operation.operation_type === 'sale.completed') {
    await applySaleCompleted(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'product.upsert') {
    await applyProductUpsert(tenantId, operation)
    await clearProductSearchCache()
    return
  }

  if (operation.operation_type === 'product.deleted') {
    await applyProductDeleted(tenantId, operation)
    await clearProductSearchCache()
    return
  }

  if (operation.operation_type === 'category.upsert') {
    await applyCategoryUpsert(tenantId, operation, role)
    clearCatalogReferenceCaches(tenantId)
    await clearProductSearchCache()
    return
  }

  if (operation.operation_type === 'category.deleted') {
    await applyCategoryDeleted(tenantId, operation)
    clearCatalogReferenceCaches(tenantId)
    await clearProductSearchCache()
    return
  }

  if (operation.operation_type === 'brand.upsert') {
    await applyBrandUpsert(tenantId, operation, role)
    clearCatalogReferenceCaches(tenantId)
    await clearProductSearchCache()
    return
  }

  if (operation.operation_type === 'brand.deleted') {
    await applyBrandDeleted(tenantId, operation)
    clearCatalogReferenceCaches(tenantId)
    await clearProductSearchCache()
    return
  }

  if (operation.operation_type === 'settings.updated') {
    await applySettingsUpdated(tenantId, operation)
    return
  }

  if (operation.operation_type === 'inventory.created') {
    await applyInventoryCreated(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'inventory.started') {
    await applyInventoryStarted(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'inventory.deleted') {
    await applyInventoryDeleted(tenantId, operation)
    return
  }
  if (operation.operation_type === 'inventory.completed' || operation.operation_type === 'inventory.document_copied') {
    await applyInventoryCompleted(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'order.payment_added') {
    await applyOrderPaymentAdded(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'order.completed') {
    await applyOrderCompleted(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'customer.debt_paid') {
    await applyCustomerDebtPaid(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'customer.deposit_changed') {
    await applyCustomerDepositChanged(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'customer.bonus_adjusted') {
    await applyCustomerBonusAdjusted(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'supplier_catalog.item_upserted') {
    await applySupplierCatalogItemUpsert(tenantId, operation)
    return
  }
  if (operation.operation_type === 'supplier_catalog.item_deleted') {
    await applySupplierCatalogItemDeleted(tenantId, operation)
    return
  }
  if (operation.operation_type === 'supplier_catalog.imported') {
    await applySupplierCatalogImported(tenantId, operation)
    return
  }
  if (operation.operation_type === 'supplier_invoice.created') {
    await applySupplierInvoiceCreated(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'supplier_invoice.updated') {
    await applySupplierInvoiceUpdated(tenantId, operation)
    return
  }

  if (operation.operation_type === 'supplier_invoice.posted') {
    await applySupplierInvoicePosted(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'supplier_invoice.payment_added') {
    await applySupplierInvoicePaymentAdded(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'supplier_invoice.cancelled') {
    await applySupplierInvoiceCancelled(tenantId, operation)
    return
  }

  if (operation.operation_type === 'supplier_invoice.deleted') {
    await applySupplierInvoiceDeleted(tenantId, operation)
    return
  }

  if (operation.operation_type === 'customer.created' || operation.operation_type === 'customer.updated') {
    await applyCustomerUpsert(tenantId, operation)
    return
  }
  if (operation.operation_type === 'customer.deleted') {
    await applyCustomerDeleted(tenantId, operation)
    return
  }
  if (operation.operation_type === 'customer_vehicle.created' || operation.operation_type === 'customer_vehicle.updated') {
    await applyCustomerVehicleUpsert(tenantId, operation)
    return
  }
  if (operation.operation_type === 'customer_vehicle.deleted') {
    await applyCustomerVehicleDeleted(tenantId, operation)
    return
  }

  if (operation.operation_type === 'supplier.created' || operation.operation_type === 'supplier.updated') {
    await applySupplierUpsert(tenantId, operation)
    return
  }
  if (operation.operation_type === 'supplier.deleted') {
    await applySupplierDeleted(tenantId, operation)
    return
  }
  if (operation.operation_type === 'supplier.merged') {
    await applySupplierMerged(tenantId, operation)
    return
  }

  if (operation.operation_type === 'order.created' || operation.operation_type === 'order.updated') {
    await applyOrderUpsert(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'order.deleted') {
    await applyOrderDeleted(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'order.status_updated') {
    await applyOrderStatusUpdated(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'order.item_status_updated') {
    await applyOrderItemStatusUpdated(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'order.items_arrived') {
    await applyOrderItemsArrived(tenantId, operation)
    return
  }
  if (operation.operation_type === 'order.canceled') {
    await applyOrderCanceled(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'staff_pin.updated') {
    await applyStaffPinUpdated(tenantId, operation)
    return
  }
  if (operation.operation_type === 'staff_user.created' || operation.operation_type === 'staff_user.updated') {
    await applyStaffUserUpsert(tenantId, operation)
    return
  }
  if (operation.operation_type === 'staff_user.deleted') {
    await applyStaffUserDeleted(tenantId, operation)
    return
  }
  if (operation.operation_type === 'commission_rule.created') {
    await applyCommissionRuleCreated(tenantId, operation)
    return
  }
  if (operation.operation_type === 'commission_rule.deleted') {
    await applyCommissionRuleDeleted(tenantId, operation)
    return
  }
  if (operation.operation_type === 'salary_payment.created') {
    await applySalaryPaymentCreated(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'salary_payment.deleted') {
    await applySalaryPaymentDeleted(tenantId, operation)
    return
  }
  if (operation.operation_type === 'cash_operation.created') {
    await applyCashOperationCreated(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'reserve.created') {
    await applyReserveCreated(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'reserve.released') {
    await applyReserveReleased(tenantId, operation)
    return
  }
  if (operation.operation_type === 'warehouse_movement.created') {
    await applyWarehouseMovementCreated(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'writeoff.created') {
    await applyWriteoffCreated(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'return.created') {
    await applyReturnCreated(tenantId, userId, operation)
    return
  }

  if (operation.operation_type === 'sale.suspended') {
    await applySuspendedSale(tenantId, userId, operation)
    return
  }
  if (operation.operation_type === 'sale.suspended_resumed' || operation.operation_type === 'sale.suspended_deleted') {
    await applySuspendedSaleClosed(tenantId, operation)
    return
  }

  throw new AppError('SYNC_UNSUPPORTED_OPERATION', `Непідтримувана операція: ${operation.operation_type}`, 400)
}







































async function applyPricingSettingsOperations(
  tenantId: string,
  operation: SyncOutboxOperation,
): Promise<void> {
  const payload = operation.payload ?? {}
  const tierUpserts = Array.isArray(payload.price_tier_upserts) ? payload.price_tier_upserts : []
  const tierDeletedIds = Array.isArray(payload.price_tier_deleted_ids) ? payload.price_tier_deleted_ids : []
  const markupUpserts = Array.isArray(payload.category_markup_upserts) ? payload.category_markup_upserts : []
  const markupDeletedIds = Array.isArray(payload.category_markup_deleted_ids) ? payload.category_markup_deleted_ids : []
  if (tierUpserts.length + tierDeletedIds.length + markupUpserts.length + markupDeletedIds.length === 0) return

  await runTransaction(async (client) => {
    for (const value of tierUpserts) {
      const row = value && typeof value === 'object' ? value as Record<string, any> : {}
      let id = String(row.id ?? '')
      const name = String(row.name ?? '').trim()
      const discountPct = Number(row.discount_pct ?? 0)
      const sortOrder = Math.trunc(Number(row.sort_order ?? 0))
      if (id === 'default') {
        const defaultTier = await client.query(
          'SELECT id FROM price_tiers WHERE tenant_id = $1 AND is_default = true ORDER BY sort_order ASC LIMIT 1',
          [tenantId],
        )
        id = defaultTier.rows[0]?.id ?? randomUUID()
      }
      if (!isUuid(id) || !name || !Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
        throw new AppError('SYNC_PRICE_TIER_INVALID', 'Некоректний рівень ціни', 400)
      }
      if (row.is_default === true) {
        await client.query('UPDATE price_tiers SET is_default = false WHERE tenant_id = $1', [tenantId])
      }
      await client.query(
        `INSERT INTO price_tiers (id, tenant_id, name, discount_pct, is_default, sort_order, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           discount_pct = EXCLUDED.discount_pct,
           is_default = EXCLUDED.is_default,
           sort_order = EXCLUDED.sort_order
         WHERE price_tiers.tenant_id = EXCLUDED.tenant_id`,
        [id, tenantId, name, discountPct, row.is_default === true, sortOrder, row.created_at ?? operation.created_at],
      )
    }

    for (const value of tierDeletedIds) {
      const id = String(value ?? '')
      if (!isUuid(id)) throw new AppError('SYNC_PRICE_TIER_INVALID', 'Некоректний рівень ціни', 400)
      await client.query(
        'UPDATE customers SET price_tier_id = NULL, updated_at = $3 WHERE tenant_id = $1 AND price_tier_id = $2',
        [tenantId, id, operation.created_at],
      )
      await client.query(
        'UPDATE volume_discounts SET price_tier_id = NULL WHERE tenant_id = $1 AND price_tier_id = $2',
        [tenantId, id],
      )
      await client.query('DELETE FROM price_tiers WHERE id = $1 AND tenant_id = $2 AND is_default = false', [id, tenantId])
    }

    for (const value of markupUpserts) {
      const row = value && typeof value === 'object' ? value as Record<string, any> : {}
      const categoryId = String(row.category_id ?? '')
      const markupPct = Number(row.markup_pct ?? 0)
      const minMarkupPct = Number(row.min_markup_pct ?? 0)
      if (!isUuid(categoryId) || !Number.isFinite(markupPct) || markupPct < 0 || markupPct > 10000
        || !Number.isFinite(minMarkupPct) || minMarkupPct < 0 || minMarkupPct > 10000) {
        throw new AppError('SYNC_CATEGORY_MARKUP_INVALID', 'Некоректна націнка категорії', 400)
      }
      const category = await client.query('SELECT id FROM categories WHERE id = $1 AND tenant_id = $2', [categoryId, tenantId])
      if (!category.rowCount) throw new AppError('SYNC_CATEGORY_NOT_FOUND', 'Категорію для націнки не знайдено', 404)
      await client.query(
        `INSERT INTO category_markups (id, tenant_id, category_id, markup_pct, min_markup_pct, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, category_id) DO UPDATE SET
           markup_pct = EXCLUDED.markup_pct,
           min_markup_pct = EXCLUDED.min_markup_pct`,
        [isUuid(row.id) ? row.id : randomUUID(), tenantId, categoryId, markupPct, minMarkupPct, row.created_at ?? operation.created_at],
      )
    }

    for (const value of markupDeletedIds) {
      const categoryId = String(value ?? '')
      if (!isUuid(categoryId)) throw new AppError('SYNC_CATEGORY_MARKUP_INVALID', 'Некоректна націнка категорії', 400)
      await client.query('DELETE FROM category_markups WHERE tenant_id = $1 AND category_id = $2', [tenantId, categoryId])
    }
  })
}
async function applySettingsUpdated(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  await applyPricingSettingsOperations(tenantId, operation)
  const requestedUpdates = pickShopSettingsPayload(operation.payload ?? {})
  const hasLabelSettings = requestedUpdates.label_settings !== undefined
  const maxAttempts = hasLabelSettings ? 3 : 1
  const originalOperationCreatedAt = typeof operation.payload?.created_at === 'string'
    ? operation.payload.created_at
    : operation.created_at
  const serverReceivedAt = new Date().toISOString()

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const updates = { ...requestedUpdates }
    let expectedUpdatedAt: string | null | undefined

    if (hasLabelSettings) {
      const { data: current, error: currentError } = await db
        .from('shop_settings')
        .select('label_settings,updated_at')
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (currentError) throw new AppError('DB_ERROR', currentError.message, 500)

      expectedUpdatedAt = current?.updated_at
      const prepared = prepareLabelSettingsUpdate({
        incoming: requestedUpdates.label_settings,
        // pushLocalOperations records the server apply time in operation.created_at,
        // while payload.created_at preserves when the offline edit was actually made.
        incomingFallbackUpdatedAt: originalOperationCreatedAt,
        current: current?.label_settings,
        currentRowUpdatedAt: current?.updated_at,
        serverReceivedAt,
      })
      if (prepared.shouldApply && prepared.normalizedIncoming) {
        updates.label_settings = prepared.normalizedIncoming
      } else {
        delete updates.label_settings
      }
    }

    if (Object.keys(updates).length === 0) return
    let query = db
      .from('shop_settings')
      // Час рядка — момент застосування на сервері. Старий offline created_at не
      // повинен відкотити sync-cursor назад і приховати зміни від інших пристроїв.
      .update({
        ...updates,
        updated_at: nextSettingsRowUpdatedAt(expectedUpdatedAt, new Date(serverReceivedAt)),
      })
      .eq('tenant_id', tenantId)
    if (hasLabelSettings) {
      query = expectedUpdatedAt == null
        ? query.is('updated_at', null)
        : query.eq('updated_at', expectedUpdatedAt)
    }
    const { data, error } = await query.select('tenant_id').maybeSingle()
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    if (data) return
    // Інший пристрій встиг зберегти налаштування: перечитуємо і порівнюємо знову.
  }

  throw new AppError(
    'SETTINGS_CONFLICT',
    'Макет етикетки одночасно змінено на іншому пристрої. Синхронізацію буде повторено.',
    409,
  )
}















