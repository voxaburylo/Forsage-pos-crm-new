/**
 * Винесено з `syncService.ts` без зміни поведінки — див. `REFACTOR_PLAN.md`,
 * ітерація 4. У файлі на 4900 рядків помилку не видно очима.
 */

import { runTransaction } from '../../db/pg.js'
import { mergeEmptySupplier } from '../supplierMergeSafety.js'
import { applySupplierHistoryMerged } from './supplierHistoryMerge.js'

import { AppError } from '../../middleware/errorHandler.js'

import { isUuid } from './syncCore.js'
import type { SyncOutboxOperation } from './syncCore.js'



export async function applySupplierUpsert(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const supplierId = String(payload.id ?? operation.aggregate_id)
  const name = String(payload.name ?? '').trim()
  if (!isUuid(supplierId) || !name) throw new AppError('SYNC_SUPPLIER_INVALID', 'Постачальник має містити id і назву', 400)
  await runTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO suppliers (
        id, tenant_id, name, phone, email, contact_name, notes, is_active,
        created_at, updated_at, deleted_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,NULL)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        contact_name = EXCLUDED.contact_name,
        notes = EXCLUDED.notes,
        is_active = EXCLUDED.is_active,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL
      WHERE suppliers.tenant_id = EXCLUDED.tenant_id AND suppliers.deleted_at IS NULL`,
      [
        supplierId, tenantId, name, payload.phone ?? null, payload.email ?? null,
        payload.contact_name ?? null, payload.notes ?? null, payload.is_active !== false,
        operation.created_at,
      ],
    )
    if (!result.rowCount) throw new AppError('SYNC_SUPPLIER_CONFLICT', 'Постачальника видалено, об’єднано або він належить іншому магазину. Картку не відновлено.', 409)
  })
}

export async function applySupplierDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  await runTransaction(async (client) => {
    await client.query(
      'UPDATE suppliers SET deleted_at = $3, is_active = false, updated_at = $3 WHERE id = $1 AND tenant_id = $2',
      [operation.aggregate_id, tenantId, operation.created_at],
    )
  })
}

export async function applySupplierMerged(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const primaryId = String(payload.primary_supplier_id ?? operation.aggregate_id)
  const duplicateId = String(payload.duplicate_supplier_id ?? '')
  if (operation.tenant_id !== tenantId || operation.operation_type !== 'supplier.merged'
    || !isUuid(operation.aggregate_id) || primaryId.toLowerCase() !== operation.aggregate_id.toLowerCase())
    throw new AppError('SYNC_SUPPLIER_MERGE_INVALID', 'Некоректне об’єднання постачальників', 400)
  if (payload.history_version !== undefined) return applySupplierHistoryMerged(tenantId, operation)
  await mergeEmptySupplier(primaryId, duplicateId, tenantId, operation.created_at)
}

export { applySupplierInvoiceCreated } from './supplierInvoiceMirror.js'

export { applySupplierInvoiceUpdated, applySupplierInvoicePosted } from './supplierInvoiceLifecycle.js'

export { applySupplierInvoicePaymentAdded } from './supplierPaymentMirror.js'

export { applySupplierInvoiceCancelled, applySupplierInvoiceDeleted } from './supplierInvoiceTerminal.js'
