import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID, type LocalSyncOutboxOperation, type LocalSyncPullChanges, type LocalSyncPullResult, type LocalSyncPullState, type LocalSyncPushResult } from '../db/localTypes'
import { LocalBootstrapRepository } from './bootstrapRepository'
import { MAX_OUTBOX_ATTEMPTS } from './outboxPolicy'

const SERVER_PULL_SCOPE = 'desktop_server_pull'
const LAST_REFERENCE_SYNC_KEY = 'desktop_last_reference_sync_at'
const CORRUPT_OUTBOX_RETRY_MS = 5 * 60_000
function nowIso(): string {
  return new Date().toISOString()
}

function parseStoredString(valueJson: string | undefined): string | null {
  if (!valueJson) return null
  try {
    const parsed = JSON.parse(valueJson)
    return typeof parsed === 'string' ? parsed : null
  } catch {
    return null
  }
}
type OutboxCandidateRow = {
  sequence: number
  operation_id: string
  tenant_id: string
  device_id: string
  aggregate_type: string
  aggregate_id: string
  operation_type: string
  payload_json: string
  created_at: string
  attempts: number
  last_error: string | null
  next_attempt_at: string | null
  status: 'pending' | 'failed'
}

function outboxDependencyKeys(row: OutboxCandidateRow, payload: any): string[] {
  const prefix = row.tenant_id
  const keys = new Set<string>([
    `${prefix}:aggregate:${row.aggregate_type}:${row.aggregate_id}`,
  ])
  const addReference = (type: 'supplier' | 'product' | 'invoice', value: unknown) => {
    if (typeof value === 'string' && value) keys.add(`${prefix}:reference:${type}:${value}`)
  }

  if (row.aggregate_type === 'supplier') addReference('supplier', row.aggregate_id)
  if (row.aggregate_type === 'product') addReference('product', row.aggregate_id)
  if (row.aggregate_type === 'supply_invoice') addReference('invoice', row.aggregate_id)

  addReference('supplier', payload?.supplier_id)
  addReference('supplier', payload?.primary_supplier_id)
  addReference('supplier', payload?.duplicate_supplier_id)
  addReference('supplier', payload?.import?.supplier_id)
  addReference('product', payload?.product_id)
  addReference('invoice', payload?.invoice_id)
  for (const item of Array.isArray(payload?.items) ? payload.items : []) {
    addReference('product', item?.product_id)
  }
  return [...keys]
}

export class LocalSyncRepository {
  constructor(private readonly db: LocalDatabase) {
    this.coalesceSupersededProductOperations()
    this.recoverLegacyReturnOutbox()
    this.recoverMissingCustomerVehicleOutbox()
  }

  getPullState(): LocalSyncPullState {
    const row = this.db.prepare(`
      SELECT pull_cursor, last_success_at, last_error
      FROM sync_state
      WHERE scope = ?
    `).get(SERVER_PULL_SCOPE) as {
      pull_cursor: string | null
      last_success_at: string | null
      last_error: string | null
    } | undefined
    const referenceRow = this.db.prepare(`
      SELECT value_json
      FROM app_meta
      WHERE key = ?
    `).get(LAST_REFERENCE_SYNC_KEY) as { value_json: string } | undefined

    return {
      cursor: row?.pull_cursor ?? null,
      last_success_at: row?.last_success_at ?? null,
      last_reference_sync_at: parseStoredString(referenceRow?.value_json),
      last_error: row?.last_error ?? null,
    }
  }

  /**
   * Здоров'я синхронізації для індикатора в UI:
   *  - pending  — щойно створені, ще не відправлені;
   *  - retrying — впали, але ще будуть повторені (attempts < MAX);
   *  - stuck    — вичерпали спроби (attempts >= MAX): самі вже не поїдуть,
   *               потрібна увага людини. Саме їх треба підсвічувати.
   */
  getSyncStatus(): {
    pending: number
    retrying: number
    stuck: number
    total: number
    oldest_created_at: string | null
    last_error: string | null
    pull_last_success_at: string | null
    pull_last_error: string | null
  } {
    const counts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'failed' AND attempts < ${MAX_OUTBOX_ATTEMPTS} THEN 1 ELSE 0 END) AS retrying,
        SUM(CASE WHEN status = 'failed' AND attempts >= ${MAX_OUTBOX_ATTEMPTS} THEN 1 ELSE 0 END) AS stuck,
        MIN(created_at) AS oldest_created_at
      FROM sync_outbox
      WHERE status IN ('pending', 'failed')
    `).get() as {
      pending: number | null
      retrying: number | null
      stuck: number | null
      oldest_created_at: string | null
    } | undefined

    const lastError = this.db.prepare(`
      SELECT last_error FROM sync_outbox
      WHERE status = 'failed' AND last_error IS NOT NULL
      ORDER BY sequence DESC LIMIT 1
    `).get() as { last_error: string | null } | undefined

    const pull = this.getPullState()
    const pending = counts?.pending ?? 0
    const retrying = counts?.retrying ?? 0
    const stuck = counts?.stuck ?? 0
    return {
      pending,
      retrying,
      stuck,
      total: pending + retrying + stuck,
      oldest_created_at: counts?.oldest_created_at ?? null,
      last_error: lastError?.last_error ?? null,
      pull_last_success_at: pull.last_success_at,
      pull_last_error: pull.last_error,
    }
  }

  applyPullChanges(changes: LocalSyncPullChanges): LocalSyncPullResult {
    if (!changes.cursor) throw new Error('LOCAL_PULL_CURSOR_REQUIRED')
    const timestamp = nowIso()
    const tenantId = changes.tenant_id ?? DEFAULT_TENANT_ID
    const importer = new LocalBootstrapRepository(this.db)
    const result = this.db.transaction(() => {
      this.markPullAttempt(timestamp)
      const applied = importer.applySyncChanges(tenantId, changes)
      this.db.prepare(`
        INSERT INTO sync_state(scope, pull_cursor, last_attempt_at, last_success_at, last_error, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?)
        ON CONFLICT(scope) DO UPDATE SET
          pull_cursor = excluded.pull_cursor,
          last_attempt_at = excluded.last_attempt_at,
          last_success_at = excluded.last_success_at,
          last_error = NULL,
          updated_at = excluded.updated_at
      `).run(SERVER_PULL_SCOPE, changes.cursor, timestamp, timestamp, timestamp)

      if (changes.references_included) {
        this.db.prepare(`
          INSERT INTO app_meta(key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `).run(LAST_REFERENCE_SYNC_KEY, JSON.stringify(timestamp), timestamp)
      }

      return applied
    })
    return result
  }

  markPullFailed(error: string): void {
    const timestamp = nowIso()
    this.db.prepare(`
      INSERT INTO sync_state(scope, last_attempt_at, last_error, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(SERVER_PULL_SCOPE, timestamp, error, timestamp)
  }

  listPending(limit = 50): LocalSyncOutboxOperation[] {
    const currentTime = nowIso()
    const maxOperations = Math.max(1, Math.min(100, limit))
    const failedRows = this.db.prepare(`
      SELECT sequence, operation_id, tenant_id, device_id, aggregate_type,
             aggregate_id, operation_type, payload_json, created_at,
             attempts, last_error, next_attempt_at, status
      FROM sync_outbox
      WHERE status = 'failed' AND attempts < ${MAX_OUTBOX_ATTEMPTS}
      ORDER BY sequence ASC
    `).all() as unknown as OutboxCandidateRow[]

    // Failed operations are barriers only for the same aggregate or an explicit
    // supplier/product/invoice dependency. They must not freeze unrelated sales.
    const blockedAt = new Map<string, number>()
    const block = (keys: string[], sequence: number) => {
      for (const key of keys) {
        const current = blockedAt.get(key)
        if (current === undefined || sequence < current) blockedAt.set(key, sequence)
      }
    }
    for (const row of failedRows) {
      let payload: any = null
      try { payload = JSON.parse(row.payload_json) } catch {}
      block(outboxDependencyKeys(row, payload), row.sequence)
    }

    // Pending work is intentionally considered before retries. A failed retry
    // can therefore never block an independent fresh sale, while dependency
    // barriers above still preserve causal order for related rows.
    const rows = this.db.prepare(`
      SELECT sequence, operation_id, tenant_id, device_id, aggregate_type,
             aggregate_id, operation_type, payload_json, created_at,
             attempts, last_error, next_attempt_at, status
      FROM sync_outbox
      WHERE (
          status = 'pending'
          OR (status = 'failed' AND attempts < ${MAX_OUTBOX_ATTEMPTS})
        )
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, sequence ASC
    `).all(currentTime) as unknown as OutboxCandidateRow[]

    const operations: LocalSyncOutboxOperation[] = []
    const corruptSequences: number[] = []
    for (const row of rows) {
      let payload: any
      try {
        payload = JSON.parse(row.payload_json)
      } catch {
        corruptSequences.push(row.sequence)
        block(outboxDependencyKeys(row, null), row.sequence)
        continue
      }
      const keys = outboxDependencyKeys(row, payload)
      const blocked = keys.some((key) => {
        const sequence = blockedAt.get(key)
        return sequence !== undefined && sequence < row.sequence
      })
      if (blocked) {
        block(keys, row.sequence)
        continue
      }
      operations.push({
        sequence: row.sequence,
        operation_id: row.operation_id,
        tenant_id: row.tenant_id,
        device_id: row.device_id,
        aggregate_type: row.aggregate_type,
        aggregate_id: row.aggregate_id,
        operation_type: row.operation_type,
        payload,
        created_at: row.created_at,
        attempts: row.attempts,
        last_error: row.last_error,
      })
      if (operations.length >= maxOperations) break
    }

    if (corruptSequences.length > 0) this.markCorruptPayloads(corruptSequences)
    return operations
  }
  applyPushResults(results: LocalSyncPushResult[]): void {
    const timestamp = nowIso()
    this.db.transaction(() => {
      for (const result of results) {
        if (result.status === 'synced') {
          const operation = this.db.prepare(`
            SELECT tenant_id, aggregate_type, aggregate_id, operation_type, payload_json, created_at
            FROM sync_outbox
            WHERE sequence = ? AND operation_id = ?
            LIMIT 1
          `).get(result.sequence, result.operation_id) as {
            tenant_id: string
            aggregate_type: string
            aggregate_id: string
            operation_type: string
            payload_json: string | null
            created_at: string
          } | undefined

          this.db.prepare(`
            UPDATE sync_outbox
            SET status = 'synced',
                synced_at = ?,
                last_error = NULL,
                next_attempt_at = NULL
            WHERE sequence = ?
              AND operation_id = ?
          `).run(timestamp, result.sequence, result.operation_id)
          if (operation) this.clearDirtyAfterPush(operation)
          continue
        }

        const nextAttemptAt = new Date(Date.now() + this.retryDelayMs(result.sequence)).toISOString()
        this.db.prepare(`
          UPDATE sync_outbox
          SET status = 'failed',
              attempts = attempts + 1,
              last_error = ?,
              next_attempt_at = ?
          WHERE sequence = ?
            AND operation_id = ?
        `).run(result.error ?? 'Помилка синхронізації', nextAttemptAt, result.sequence, result.operation_id)
      }
    })
  }

  markBatchFailed(sequences: number[], error: string): void {
    if (sequences.length === 0) return
    const timestamp = new Date(Date.now() + 15_000).toISOString()
    this.db.transaction(() => {
      for (const sequence of sequences) {
        this.db.prepare(`
          UPDATE sync_outbox
          SET status = 'failed',
              attempts = attempts + 1,
              last_error = ?,
              next_attempt_at = ?
          WHERE sequence = ?
            AND status <> 'synced'
        `).run(error, timestamp, sequence)
      }
    })
  }


  private clearDirtyAfterPush(operation: {
    tenant_id: string
    aggregate_type: string
    aggregate_id: string
    operation_type: string
    payload_json: string | null
    created_at: string
  }): void {
    let payload: any = null
    try {
      payload = operation.payload_json ? JSON.parse(operation.payload_json) : null
    } catch {
      payload = null
    }

    const clearRow = (table: string, id: unknown, idColumn = 'id') => {
      if (typeof id !== 'string' || !id) return
      this.db.prepare(`
        UPDATE ${table}
        SET dirty_at = NULL
        WHERE ${idColumn} = ? AND (dirty_at IS NULL OR dirty_at <= ?)
      `).run(id, operation.created_at)
    }
    const clearChildren = (table: string, parentColumn: string, parentId: unknown) => {
      if (typeof parentId !== 'string' || !parentId) return
      this.db.prepare(`
        UPDATE ${table}
        SET dirty_at = NULL
        WHERE ${parentColumn} = ? AND (dirty_at IS NULL OR dirty_at <= ?)
      `).run(parentId, operation.created_at)
    }

    if (operation.operation_type === 'product.upsert' || operation.operation_type === 'product.deleted') {
      clearRow('products', operation.aggregate_id)
      return
    }

    if (operation.operation_type.startsWith('category.')) {
      clearRow('categories', operation.aggregate_id)
      if (operation.operation_type === 'category.deleted') {
        this.db.prepare(`
          UPDATE products SET dirty_at = NULL
          WHERE category_id IS NULL AND dirty_at = ?
        `).run(operation.created_at)
      }
      return
    }
    if (operation.operation_type.startsWith('brand.')) {
      clearRow('brands', operation.aggregate_id)
      if (operation.operation_type === 'brand.deleted') {
        this.db.prepare(`
          UPDATE products SET dirty_at = NULL
          WHERE brand_id IS NULL AND dirty_at = ?
        `).run(operation.created_at)
      }
      return
    }

    if (operation.operation_type === 'customer.created'
      || operation.operation_type === 'customer.updated'
      || operation.operation_type === 'customer.deleted') {
      clearRow('customers', operation.aggregate_id)
      if (operation.operation_type === 'customer.deleted') {
        clearChildren('customer_vehicles', 'customer_id', operation.aggregate_id)
      }
      return
    }
    if (operation.operation_type.startsWith('customer_vehicle.')) {
      clearRow('customer_vehicles', operation.aggregate_id)
      return
    }

    if (operation.operation_type === 'customer.debt_paid' || operation.operation_type === 'customer.deposit_changed') {
      clearRow('customers', operation.aggregate_id)
      clearRow('customer_deposit_transactions', payload?.transaction_id)
      if (typeof payload?.cash_operation_id === 'string' && payload.cash_operation_id) {
        clearRow('cash_operations', payload.cash_operation_id)
      } else {
        this.db.prepare(`
          UPDATE cash_operations
          SET dirty_at = NULL
          WHERE dirty_at = ? AND type = 'cash_in'
        `).run(operation.created_at)
      }
      return
    }
    if (operation.operation_type === 'customer.bonus_adjusted') {
      clearRow('customers', operation.aggregate_id)
      clearRow('bonus_transactions', payload?.transaction_id)
      return
    }
    if (operation.operation_type === 'supplier_catalog.item_upserted'
      || operation.operation_type === 'supplier_catalog.item_deleted') {
      clearRow('supplier_price_items', operation.aggregate_id)
      return
    }
    if (operation.operation_type === 'supplier_catalog.imported') {
      clearRow('supplier_price_imports', operation.aggregate_id)
      this.db.prepare(`
        UPDATE supplier_price_items
        SET dirty_at = NULL
        WHERE tenant_id = ? AND dirty_at = ?
      `).run(operation.tenant_id, operation.created_at)
      return
    }
    if (operation.operation_type.startsWith('supplier.')) {
      clearRow('suppliers', operation.aggregate_id)
      if (operation.operation_type === 'supplier.merged') {
        clearRow('suppliers', payload?.primary_supplier_id)
        clearRow('suppliers', payload?.duplicate_supplier_id)
        for (const table of ['supply_invoices', 'supplier_payments']) {
          this.db.prepare(`
            UPDATE ${table} SET dirty_at = NULL
            WHERE supplier_id = ? AND dirty_at = ?
          `).run(payload?.primary_supplier_id ?? null, operation.created_at)
        }
      }
      return
    }

    if (operation.operation_type === 'shift.opened' || operation.operation_type === 'shift.closed') {
      clearRow('shifts', operation.aggregate_id)
      return
    }

    if (operation.operation_type === 'sale.completed') {
      clearRow('sales', operation.aggregate_id)
      clearChildren('cash_operations', 'sale_id', operation.aggregate_id)
      clearChildren('bonus_transactions', 'source_sale_id', operation.aggregate_id)
      clearChildren('inventory_movements', 'source_id', operation.aggregate_id)
      clearRow('customers', payload?.customer_id)
      this.clearDirtyProductsFromPayload(operation)
      return
    }
    if (operation.operation_type === 'sale.suspended'
      || operation.operation_type === 'sale.suspended_resumed'
      || operation.operation_type === 'sale.suspended_deleted') {
      clearRow('sales', operation.aggregate_id)
      return
    }

    if (operation.operation_type === 'return.created') {
      clearRow('customer_returns', operation.aggregate_id)
      const localReturn = this.db.prepare(`
        SELECT customer_id FROM customer_returns WHERE id = ? LIMIT 1
      `).get(operation.aggregate_id) as { customer_id: string | null } | undefined
      clearRow('customers', localReturn?.customer_id)
      clearChildren('inventory_movements', 'source_id', operation.aggregate_id)
      this.db.prepare(`
        UPDATE customer_deposit_transactions
        SET dirty_at = NULL
        WHERE sale_id = ?
          AND method = 'return_credit'
          AND (dirty_at IS NULL OR dirty_at <= ?)
      `).run(payload?.sale_id ?? null, operation.created_at)
      this.db.prepare(`
        UPDATE cash_operations
        SET dirty_at = NULL
        WHERE dirty_at = ? AND type = 'return_cash'
      `).run(operation.created_at)
      this.clearDirtyProductsFromPayload(operation)
      return
    }

    if (operation.operation_type === 'inventory.created' || operation.operation_type === 'inventory.started') {
      clearRow('inventory_sessions', operation.aggregate_id)
      return
    }
    if (operation.operation_type === 'inventory.deleted') {
      return
    }

    if (operation.operation_type === 'inventory.completed') {
      clearRow('inventory_sessions', operation.aggregate_id)
      clearChildren('inventory_movements', 'source_id', operation.aggregate_id)
      this.clearDirtyProductsFromPayload(operation)
      return
    }

    if (operation.operation_type === 'order.payment_added') {
      clearRow('customer_orders', operation.aggregate_id)
      clearRow('customers', payload?.customer_id)
      clearRow('customer_deposit_transactions', payload?.account_transaction_id)
      clearRow('order_payments', payload?.payment_id)
      this.db.prepare(`
        UPDATE cash_operations
        SET dirty_at = NULL
        WHERE dirty_at = ? AND type = 'cash_in'
      `).run(operation.created_at)
      return
    }

    if (operation.operation_type === 'order.completed') {
      clearRow('customer_orders', operation.aggregate_id)
      clearChildren('customer_order_items', 'order_id', operation.aggregate_id)
      clearChildren('stock_reserves', 'order_id', operation.aggregate_id)
      clearRow('sales', payload?.sale_id)
      clearChildren('cash_operations', 'sale_id', payload?.sale_id)
      clearChildren('inventory_movements', 'source_id', operation.aggregate_id)
      clearChildren('inventory_movements', 'source_id', payload?.sale_id)
      clearRow('customers', payload?.customer_id)
      this.clearDirtyProductsFromPayload(operation)
      return
    }

    if (operation.operation_type === 'order.created'
      || operation.operation_type === 'order.updated'
      || operation.operation_type === 'order.deleted') {
      clearRow('customer_orders', operation.aggregate_id)
      clearChildren('customer_order_items', 'order_id', operation.aggregate_id)
      return
    }
    if (operation.operation_type === 'order.status_updated' || operation.operation_type === 'order.canceled') {
      clearRow('customer_orders', operation.aggregate_id)
      return
    }
    if (operation.operation_type === 'order.item_status_updated') {
      clearRow('customer_order_items', payload?.item_id)
      return
    }
    if (operation.operation_type === 'order.items_arrived') {
      for (const id of Array.isArray(payload?.item_ids) ? payload.item_ids : []) {
        clearRow('customer_order_items', id)
      }
      return
    }

    if (operation.operation_type.startsWith('supplier_invoice.')) {
      clearRow('supply_invoices', operation.aggregate_id)
      clearChildren('supply_invoice_items', 'invoice_id', operation.aggregate_id)
      clearRow('supplier_payments', payload?.payment_id)
      this.db.prepare(`
        UPDATE cash_operations SET dirty_at = NULL
        WHERE type = 'supplier_payment'
          AND supplier_id = (SELECT supplier_id FROM supply_invoices WHERE id = ? LIMIT 1)
          AND dirty_at = ?
      `).run(operation.aggregate_id, operation.created_at)
      clearChildren('inventory_movements', 'source_id', operation.aggregate_id)
      this.clearDirtyProductsFromPayload(operation)
      return
    }

    if (operation.operation_type === 'staff_pin.updated') {
      return
    }
    if (operation.operation_type.startsWith('staff_user.')) {
      clearRow('staff_users', operation.aggregate_id)
      return
    }
    if (operation.operation_type.startsWith('commission_rule.')) {
      clearRow('commission_rules', operation.aggregate_id)
      return
    }
    if (operation.operation_type.startsWith('salary_payment.')) {
      const localSalary = this.db.prepare(`
        SELECT cash_operation_id FROM salary_payments WHERE id = ? LIMIT 1
      `).get(operation.aggregate_id) as { cash_operation_id: string | null } | undefined
      clearRow('salary_payments', operation.aggregate_id)
      clearRow('cash_operations', localSalary?.cash_operation_id)
      return
    }
    if (operation.operation_type === 'cash_operation.created') {
      clearRow('cash_operations', operation.aggregate_id)
      return
    }

    if (operation.operation_type === 'reserve.created' || operation.operation_type === 'reserve.released') {
      clearRow('stock_reserves', operation.aggregate_id)
      return
    }
    if (operation.operation_type === 'warehouse_movement.created') {
      clearRow('warehouse_movements', operation.aggregate_id)
      return
    }
    if (operation.operation_type === 'writeoff.created') {
      clearRow('writeoffs', operation.aggregate_id)
      clearChildren('inventory_movements', 'source_id', operation.aggregate_id)
      this.clearDirtyProductsFromPayload(operation)
    }
  }

  private clearDirtyProductsFromPayload(operation: { payload_json: string | null; created_at: string }): void {
    try {
      const payload = operation.payload_json ? JSON.parse(operation.payload_json) : null
      const ids: string[] = Array.isArray(payload?.items)
        ? [...new Set<string>(payload.items.map((item: any) => item?.product_id).filter((id: any): id is string => typeof id === 'string' && id.length > 0))]
        : []
      for (const productId of ids) {
        this.db.prepare(`
          UPDATE products
          SET dirty_at = NULL
          WHERE id = ? AND (dirty_at IS NULL OR dirty_at <= ?)
        `).run(productId, operation.created_at)
      }
    } catch {
      // Якщо payload пошкоджений, pull пізніше вирівняє серверний стан.
    }
  }


  private recoverLegacyReturnOutbox(): void {
    // Builds before the shift-reconciliation fix permanently exhausted retries for
    // otherwise valid cash returns. Give only those known shift failures one retry
    // cycle; all other failed operations keep their normal safety limit.
    this.db.prepare(`
      UPDATE sync_outbox
      SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL
      WHERE operation_type = 'return.created'
        AND status = 'failed'
        AND (
          last_error LIKE '%кассов%смен%'
          OR last_error LIKE '%касов%змін%'
          OR last_error LIKE '%SHIFT_REQUIRED%'
          OR last_error LIKE '%SHIFT_INVALID%'
        )
    `).run()
  }
  private recoverMissingCustomerVehicleOutbox(): void {
    const rows = this.db.prepare(`
      SELECT v.id, v.tenant_id, v.customer_id, v.brand, v.model, v.year, v.vin,
             v.notes, v.remote_updated_at, v.deleted_at, v.dirty_at, v.created_at, v.updated_at
      FROM customer_vehicles v
      WHERE v.dirty_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM sync_outbox o
          WHERE o.tenant_id = v.tenant_id
            AND o.aggregate_type = 'customer_vehicle'
            AND o.aggregate_id = v.id
            AND o.status <> 'synced'
        )
    `).all() as any[]

    if (rows.length === 0) return
    this.db.transaction(() => {
      for (const row of rows) {
        const timestamp = row.dirty_at ?? row.updated_at ?? nowIso()
        const operationType = row.deleted_at
          ? 'customer_vehicle.deleted'
          : (row.remote_updated_at ? 'customer_vehicle.updated' : 'customer_vehicle.created')
        this.db.prepare(`
          INSERT INTO sync_outbox (
            operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
            operation_type, payload_json, status, created_at
          ) VALUES (?, ?, ?, 'customer_vehicle', ?, ?, ?, 'pending', ?)
        `).run(
          randomUUID(),
          row.tenant_id,
          this.db.deviceId,
          row.id,
          operationType,
          JSON.stringify({
            id: row.id,
            customer_id: row.customer_id,
            brand: row.brand,
            model: row.model,
            year: row.year,
            vin: row.vin,
            notes: row.notes,
          }),
          timestamp,
        )
      }
    })
  }

  private coalesceSupersededProductOperations(): void {
    const rows = this.db.prepare(`
      SELECT sequence, aggregate_id, operation_type, payload_json
      FROM sync_outbox
      WHERE aggregate_type = 'product'
        AND operation_type IN ('product.upsert', 'product.deleted')
        AND status IN ('pending', 'failed')
      ORDER BY aggregate_id, sequence DESC
    `).all() as Array<{
      sequence: number
      aggregate_id: string
      operation_type: 'product.upsert' | 'product.deleted'
      payload_json: string
    }>
    if (rows.length < 2) return

    const superseded: number[] = []
    for (const aggregateId of new Set(rows.map((row) => row.aggregate_id))) {
      const operations = rows.filter((row) => row.aggregate_id === aggregateId)
      const newest = operations[0]
      const keep = new Set<number>([newest.sequence])
      if (newest.operation_type === 'product.upsert') {
        const latestCorrection = operations.find((row) => {
          if (row.operation_type !== 'product.upsert') return false
          try {
            return JSON.parse(row.payload_json)?.stock_correction === true
          } catch {
            return false
          }
        })
        if (latestCorrection) keep.add(latestCorrection.sequence)
      }
      for (const row of operations) {
        if (!keep.has(row.sequence)) superseded.push(row.sequence)
      }
    }
    if (superseded.length === 0) return

    const timestamp = nowIso()
    this.db.transaction(() => {
      const update = this.db.prepare(`
        UPDATE sync_outbox
        SET status = 'synced', synced_at = ?, next_attempt_at = NULL,
            last_error = 'Замінено новішою версією товару'
        WHERE sequence = ? AND status IN ('pending', 'failed')
      `)
      for (const sequence of superseded) update.run(timestamp, sequence)
    })
  }
  private retryDelayMs(sequence: number): number {
    const row = this.db.prepare('SELECT attempts FROM sync_outbox WHERE sequence = ?').get(sequence) as { attempts: number } | undefined
    const attempts = Math.max(0, row?.attempts ?? 0)
    return Math.min(5 * 60_000, 15_000 * (2 ** attempts))
  }

  private markCorruptPayloads(sequences: number[]): void {
    const nextAttemptAt = new Date(Date.now() + CORRUPT_OUTBOX_RETRY_MS).toISOString()
    this.db.transaction(() => {
      for (const sequence of sequences) {
        this.db.prepare(`
          UPDATE sync_outbox
          SET status = 'failed',
              attempts = attempts + 1,
              last_error = ?,
              next_attempt_at = ?
          WHERE sequence = ?
            AND status <> 'synced'
        `).run('Пошкоджений локальний запис синхронізації: неможливо прочитати payload_json', nextAttemptAt, sequence)
      }
    })
  }

  private markPullAttempt(timestamp: string): void {
    this.db.prepare(`
      INSERT INTO sync_state(scope, last_attempt_at, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        updated_at = excluded.updated_at
    `).run(SERVER_PULL_SCOPE, timestamp, timestamp)
  }
}
