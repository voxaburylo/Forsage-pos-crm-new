/**
 * Винесено з `syncService.ts` без зміни поведінки — див. `REFACTOR_PLAN.md`,
 * ітерація 4. У файлі на 4900 рядків помилку не видно очима.
 */

import { runTransaction } from '../../db/pg.js'
import { db } from '../../db/supabase.js'
import { AppError } from '../../middleware/errorHandler.js'
import { checkedSyncMoney } from '../syncMoney.js'
import { isUuid } from './syncCore.js'
import type { SyncOutboxOperation } from './syncCore.js'
import { assertSyncCashboxHasFunds } from './syncGuards.js'
import { invoiceLineTotal } from './syncMath.js'
import { randomUUID } from 'node:crypto'

export async function applySupplierUpsert(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const supplierId = String(payload.id ?? operation.aggregate_id)
  const name = String(payload.name ?? '').trim()
  if (!isUuid(supplierId) || !name) throw new AppError('SYNC_SUPPLIER_INVALID', 'Постачальник має містити id і назву', 400)
  await runTransaction(async (client) => {
    await client.query(
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
      WHERE suppliers.tenant_id = EXCLUDED.tenant_id`,
      [
        supplierId, tenantId, name, payload.phone ?? null, payload.email ?? null,
        payload.contact_name ?? null, payload.notes ?? null, payload.is_active !== false,
        operation.created_at,
      ],
    )
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
  if (!isUuid(primaryId) || !isUuid(duplicateId) || primaryId === duplicateId) {
    throw new AppError('SYNC_SUPPLIER_MERGE_INVALID', 'Некоректне об’єднання постачальників', 400)
  }
  await runTransaction(async (client) => {
    const primary = await client.query('SELECT id FROM suppliers WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL', [primaryId, tenantId])
    if (!primary.rowCount) throw new AppError('SYNC_SUPPLIER_NOT_FOUND', 'Основного постачальника не знайдено', 404)
    await client.query('UPDATE supply_invoices SET supplier_id = $1, updated_at = $3 WHERE supplier_id = $2 AND tenant_id = $4', [primaryId, duplicateId, operation.created_at, tenantId])
    await client.query(
      'UPDATE supplier_payments SET supplier_id = $1, updated_at = $4 WHERE supplier_id = $2 AND tenant_id = $3',
      [primaryId, duplicateId, tenantId, operation.created_at],
    )
    await client.query('UPDATE suppliers SET deleted_at = $3, is_active = false, updated_at = $3 WHERE id = $1 AND tenant_id = $2', [duplicateId, tenantId, operation.created_at])
  })
}

export async function applySupplierInvoiceCreated(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const invoiceId = String(payload.id || operation.aggregate_id)
  const items = Array.isArray(payload.items) ? payload.items : []
  if (items.length === 0) throw new AppError('SYNC_INVOICE_EMPTY', 'У накладній немає товарів', 422)
  let total: number
  let requestedPaidAmount: number
  try {
    total = checkedSyncMoney(
      items.reduce((sum: number, item: any) => sum + invoiceLineTotal(item), 0),
      'Сума накладної',
    )
    requestedPaidAmount = checkedSyncMoney(payload.paid_amount ?? 0, 'Сума оплати')
  } catch (error: any) {
    throw new AppError('SYNC_INVOICE_AMOUNT_INVALID', error?.message ?? 'Некоректна сума накладної', 422)
  }
  const paidAmount = Math.min(requestedPaidAmount, total)
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at

  await runTransaction(async (client) => {
    const existing = await client.query('SELECT id FROM supply_invoices WHERE id = $1 AND tenant_id = $2 LIMIT 1', [invoiceId, tenantId])
    if (existing.rowCount && existing.rowCount > 0) return

    await client.query(
      `INSERT INTO supply_invoices (
        id, tenant_id, supplier_id, invoice_number, status, total, paid_amount,
        payment_method, notes, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10)`,
      [invoiceId, tenantId, payload.supplier_id ?? null, payload.invoice_number ?? null, total, paidAmount, paidAmount > 0 ? (payload.payment_method ?? 'cash') : null, payload.notes ?? null, createdAt, appliedAt],
    )

    for (const item of items) {
      await client.query(
        `INSERT INTO supply_invoice_items (id, tenant_id, invoice_id, product_id, qty, purchase_price, total, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [item.id ?? randomUUID(), tenantId, invoiceId, item.product_id, Number(item.qty ?? 0), Number(item.purchase_price ?? 0), invoiceLineTotal(item), createdAt],
      )
    }

    if (paidAmount > 0) {
      const paymentId = payload.payment_id ?? randomUUID()
      const method = payload.payment_method ?? 'cash'
      const fundSource = payload.fund_source ?? (method === 'cash' ? 'cashbox' : 'bank_account')
      if (fundSource === 'cashbox') {
        if (!isUuid(payload.shift_id)) throw new AppError('SHIFT_REQUIRED', 'Щоб платити з каси, потрібна відкрита касова зміна', 409)
        await assertSyncCashboxHasFunds(client, tenantId, payload.shift_id, paidAmount, createdAt)
      }
      await client.query(
        `INSERT INTO supplier_payments
         (id, tenant_id, invoice_id, supplier_id, amount, payment_method, fund_source, shift_id, note, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO NOTHING`,
        [paymentId, tenantId, invoiceId, payload.supplier_id ?? null, paidAmount, method, fundSource, payload.shift_id ?? null, 'Оплата під час створення накладної', userId, createdAt, appliedAt],
      )
      if (fundSource === 'cashbox') {
        await client.query(
          `INSERT INTO cash_operations (id, tenant_id, shift_id, type, amount, note, source, created_by, created_at, updated_at)
           VALUES ($1,$2,$3,'out',$4,$5,'cashbox',$6,$7,$8)
           ON CONFLICT (id) DO NOTHING`,
          [paymentId, tenantId, payload.shift_id, paidAmount, 'Оплата постачальнику під час створення накладної', userId, createdAt, appliedAt],
        )
      }
    }
  })
}

export async function applySupplierInvoiceUpdated(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const hasItems = Array.isArray(payload.items)
  const items = hasItems ? payload.items : []
  const total = hasItems
    ? items.reduce((sum: number, item: any) => sum + invoiceLineTotal(item), 0)
    : Math.max(0, Math.round(Number(payload.total ?? 0)))
  const timestamp = operation.applied_at ?? operation.created_at ?? new Date().toISOString()

  await runTransaction(async (client) => {
    const invoice = await client.query(
      'SELECT status, supplier_id, invoice_number, notes, total FROM supply_invoices WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE',
      [operation.aggregate_id, tenantId],
    )
    if (!invoice.rowCount) throw new AppError('NOT_FOUND', 'Накладну не знайдено', 404)
    if (invoice.rows[0].status !== 'draft') throw new AppError('INVOICE_POSTED', 'Не можна редагувати проведену накладну', 400)

    await client.query(
      `UPDATE supply_invoices
       SET supplier_id = $1, invoice_number = $2, notes = $3, total = $4,
           draft_payload = NULL, draft_saved_at = NULL, draft_saved_by = NULL,
           updated_at = $5
       WHERE id = $6 AND tenant_id = $7`,
      [
        Object.prototype.hasOwnProperty.call(payload, 'supplier_id') ? payload.supplier_id ?? null : invoice.rows[0].supplier_id ?? null,
        Object.prototype.hasOwnProperty.call(payload, 'invoice_number') ? payload.invoice_number ?? null : invoice.rows[0].invoice_number ?? null,
        Object.prototype.hasOwnProperty.call(payload, 'notes') ? payload.notes ?? null : invoice.rows[0].notes ?? null,
        hasItems ? total : Number(invoice.rows[0].total ?? 0),
        timestamp,
        operation.aggregate_id,
        tenantId,
      ],
    )

    if (hasItems) {
      if (items.length === 0) throw new AppError('SYNC_INVOICE_EMPTY', 'У накладній немає товарів', 422)
      await client.query('DELETE FROM supply_invoice_items WHERE invoice_id = $1 AND tenant_id = $2', [operation.aggregate_id, tenantId])
      for (const item of items) {
        await client.query(
          `INSERT INTO supply_invoice_items (id, tenant_id, invoice_id, product_id, qty, purchase_price, total, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            item.id ?? randomUUID(),
            tenantId,
            operation.aggregate_id,
            item.product_id,
            Number(item.qty ?? 0),
            Number(item.purchase_price ?? 0),
            invoiceLineTotal(item),
            timestamp,
          ],
        )
      }
    }
  })
}

export async function applySupplierInvoicePosted(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const { data: invoice } = await db
    .from('supply_invoices')
    .select('id,status')
    .eq('id', operation.aggregate_id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .single()
  if (!invoice) throw new AppError('NOT_FOUND', 'Накладну не знайдено', 404)
  if (invoice.status === 'posted') return
  const { error } = await db.rpc('post_supply_invoice', {
    p_invoice_id: operation.aggregate_id,
    p_user_id: userId,
  })
  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

export async function applySupplierInvoicePaymentAdded(tenantId: string, userId: string, operation: SyncOutboxOperation): Promise<void> {
  const payload = operation.payload ?? {}
  const paymentId = String(payload.payment_id || operation.operation_id)
  let amount: number
  try {
    amount = checkedSyncMoney(payload.amount ?? 0, 'Сума оплати')
  } catch (error: any) {
    throw new AppError('INVALID_AMOUNT', error?.message ?? 'Некоректна сума оплати', 422)
  }
  if (amount <= 0) throw new AppError('INVALID_AMOUNT', 'Сума оплати має бути більше нуля', 422)
  const createdAt = payload.created_at ?? operation.created_at
  const appliedAt = operation.applied_at ?? operation.created_at
  await runTransaction(async (client) => {
    const existing = await client.query('SELECT id FROM supplier_payments WHERE id = $1 LIMIT 1', [paymentId])
    if (existing.rowCount && existing.rowCount > 0) return
    const invoiceResult = await client.query(
      `SELECT id, supplier_id, total, COALESCE(paid_amount, 0) AS paid_amount
       FROM supply_invoices WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [operation.aggregate_id, tenantId],
    )
    const invoice = invoiceResult.rows[0]
    if (!invoice) throw new AppError('NOT_FOUND', 'Накладну не знайдено', 404)
    const remaining = Number(invoice.total) - Number(invoice.paid_amount)
    if (amount > remaining) throw new AppError('PAYMENT_TOO_LARGE', 'Сума перевищує борг за накладною', 422)
    const method = payload.payment_method ?? 'cash'
    const fundSource = payload.fund_source ?? (method === 'cash' ? 'cashbox' : 'bank_account')
    if (fundSource === 'cashbox') {
      if (!isUuid(payload.shift_id)) {
        throw new AppError('SHIFT_REQUIRED', 'Щоб платити з каси, потрібна відкрита касова зміна', 409)
      }
      await assertSyncCashboxHasFunds(client, tenantId, payload.shift_id, amount, createdAt)
    }
    await client.query(
      `INSERT INTO supplier_payments
       (id, tenant_id, invoice_id, supplier_id, amount, payment_method, fund_source, shift_id, note, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [paymentId, tenantId, operation.aggregate_id, invoice.supplier_id, amount, method, fundSource, payload.shift_id ?? null, payload.note ?? null, userId, createdAt, appliedAt],
    )
    await client.query(
      'UPDATE supply_invoices SET paid_amount = COALESCE(paid_amount, 0) + $1, payment_method = $2, updated_at = $5 WHERE id = $3 AND tenant_id = $4',
      [amount, method, operation.aggregate_id, tenantId, appliedAt],
    )
    if (fundSource === 'cashbox') {
      await client.query(
        `INSERT INTO cash_operations (id, tenant_id, shift_id, type, amount, note, created_by, source, created_at, updated_at)
         VALUES ($1,$2,$3,'out',$4,$5,$6,'cashbox',$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [paymentId, tenantId, payload.shift_id, amount, payload.note || 'Оплата постачальнику', userId, createdAt, appliedAt],
      )
    }
  })
}

export async function applySupplierInvoiceCancelled(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  const { data: invoice } = await db
    .from('supply_invoices')
    .select('id,status,paid_amount')
    .eq('id', operation.aggregate_id)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .single()
  if (!invoice) return
  if (invoice.status === 'cancelled') return
  if (Number(invoice.paid_amount ?? 0) > 0) {
    throw new AppError('PAID_INVOICE_CANNOT_BE_CANCELLED', 'Не можна скасувати оплачену накладну', 409)
  }
  const { error } = await db.rpc('cancel_supply_invoice', { p_invoice_id: operation.aggregate_id })
  if (error) throw new AppError('DB_ERROR', error.message, 500)
}

export async function applySupplierInvoiceDeleted(tenantId: string, operation: SyncOutboxOperation): Promise<void> {
  await runTransaction(async (client) => {
    const invoiceResult = await client.query('SELECT status, paid_amount, deleted_at FROM supply_invoices WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE', [operation.aggregate_id, tenantId])
    const invoice = invoiceResult.rows[0]
    if (!invoice || invoice.deleted_at) return
    if (invoice.status !== 'draft' || Number(invoice.paid_amount ?? 0) > 0) {
      throw new AppError('INVOICE_DELETE_FORBIDDEN', 'Видалити можна лише неоплачену чернетку накладної', 409)
    }
    await client.query(
      `UPDATE supply_invoices
       SET deleted_at = $3, updated_at = $3
       WHERE id = $1 AND tenant_id = $2`,
      [operation.aggregate_id, tenantId, operation.created_at],
    )
  })
}
