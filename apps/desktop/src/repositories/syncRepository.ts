import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID, type LocalSyncOutboxOperation, type LocalSyncPullChanges, type LocalSyncPullResult, type LocalSyncPullState, type LocalSyncPushResult } from '../db/localTypes'
import { LocalBootstrapRepository } from './bootstrapRepository'

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

export class LocalSyncRepository {
  constructor(private readonly db: LocalDatabase) {}

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
    const rows = this.db.prepare(`
      SELECT sequence, operation_id, tenant_id, device_id, aggregate_type,
             aggregate_id, operation_type, payload_json, created_at,
             attempts, last_error
      FROM sync_outbox
      WHERE status IN ('pending', 'failed')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY sequence ASC
      LIMIT ?
    `).all(nowIso(), Math.max(1, Math.min(100, limit))) as Array<{
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
    }>

    const operations: LocalSyncOutboxOperation[] = []
    const corruptSequences: number[] = []

    for (const row of rows) {
      try {
        operations.push({
          sequence: row.sequence,
          operation_id: row.operation_id,
          tenant_id: row.tenant_id,
          device_id: row.device_id,
          aggregate_type: row.aggregate_type,
          aggregate_id: row.aggregate_id,
          operation_type: row.operation_type,
          payload: JSON.parse(row.payload_json),
          created_at: row.created_at,
          attempts: row.attempts,
          last_error: row.last_error,
        })
      } catch {
        corruptSequences.push(row.sequence)
      }
    }

    if (corruptSequences.length > 0) {
      this.markCorruptPayloads(corruptSequences)
    }

    return operations
  }

  applyPushResults(results: LocalSyncPushResult[]): void {
    const timestamp = nowIso()
    this.db.transaction(() => {
      for (const result of results) {
        if (result.status === 'synced') {
          const operation = this.db.prepare(`
            SELECT aggregate_type, aggregate_id, operation_type, payload_json, created_at
            FROM sync_outbox
            WHERE sequence = ? AND operation_id = ?
            LIMIT 1
          `).get(result.sequence, result.operation_id) as {
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
    aggregate_type: string
    aggregate_id: string
    operation_type: string
    payload_json: string | null
    created_at: string
  }): void {
    if (operation.operation_type === 'product.upsert' || operation.operation_type === 'product.deleted') {
      this.db.prepare(`
        UPDATE products
        SET dirty_at = NULL
        WHERE id = ? AND (dirty_at IS NULL OR dirty_at <= ?)
      `).run(operation.aggregate_id, operation.created_at)
      return
    }

    if (operation.operation_type === 'inventory.completed') {
      this.db.prepare(`
        UPDATE inventory_sessions
        SET dirty_at = NULL
        WHERE id = ? AND (dirty_at IS NULL OR dirty_at <= ?)
      `).run(operation.aggregate_id, operation.created_at)
      this.clearDirtyProductsFromPayload(operation)
      return
    }

    if (operation.operation_type === 'customer.debt_paid' || operation.operation_type === 'customer.deposit_changed') {
      this.db.prepare(`
        UPDATE customers
        SET dirty_at = NULL
        WHERE id = ? AND (dirty_at IS NULL OR dirty_at <= ?)
      `).run(operation.aggregate_id, operation.created_at)
      try {
        const payload = operation.payload_json ? JSON.parse(operation.payload_json) : null
        if (payload?.transaction_id) {
          this.db.prepare(`
            UPDATE customer_deposit_transactions
            SET dirty_at = NULL
            WHERE id = ? AND (dirty_at IS NULL OR dirty_at <= ?)
          `).run(payload.transaction_id, operation.created_at)
        }
      } catch { /* ignore */ }
      return
    }
    if (operation.operation_type === 'order.payment_added') {
      this.db.prepare(`
        UPDATE customer_orders
        SET dirty_at = NULL
        WHERE id = ? AND (dirty_at IS NULL OR dirty_at <= ?)
      `).run(operation.aggregate_id, operation.created_at)
      try {
        const payload = operation.payload_json ? JSON.parse(operation.payload_json) : null
        if (payload?.customer_id) {
          this.db.prepare(`
            UPDATE customers
            SET dirty_at = NULL
            WHERE id = ? AND (dirty_at IS NULL OR dirty_at <= ?)
          `).run(payload.customer_id, operation.created_at)
        }
        if (payload?.account_transaction_id) {
          this.db.prepare(`
            UPDATE customer_deposit_transactions
            SET dirty_at = NULL
            WHERE id = ? AND (dirty_at IS NULL OR dirty_at <= ?)
          `).run(payload.account_transaction_id, operation.created_at)
        }

        if (payload?.payment_id) {
          this.db.prepare(`
            UPDATE order_payments
            SET dirty_at = NULL
            WHERE id = ? AND (dirty_at IS NULL OR dirty_at <= ?)
          `).run(payload.payment_id, operation.created_at)
        }
      } catch { /* ignore */ }
      return
    }

    if (operation.operation_type === 'order.completed') {
      this.db.prepare(`
        UPDATE customer_orders
        SET dirty_at = NULL
        WHERE id = ? AND (dirty_at IS NULL OR dirty_at <= ?)
      `).run(operation.aggregate_id, operation.created_at)
      this.db.prepare(`
        UPDATE customer_order_items
        SET dirty_at = NULL
        WHERE order_id = ? AND (dirty_at IS NULL OR dirty_at <= ?)
      `).run(operation.aggregate_id, operation.created_at)
      this.clearDirtyProductsFromPayload(operation)
      return
    }

    if (operation.operation_type.startsWith('supplier_invoice.')) {
      this.db.prepare(`
        UPDATE supply_invoices
        SET dirty_at = NULL
        WHERE id = ? AND (dirty_at IS NULL OR dirty_at <= ?)
      `).run(operation.aggregate_id, operation.created_at)
      this.db.prepare(`
        UPDATE supply_invoice_items
        SET dirty_at = NULL
        WHERE invoice_id = ? AND (dirty_at IS NULL OR dirty_at <= ?)
      `).run(operation.aggregate_id, operation.created_at)
      try {
        const payload = operation.payload_json ? JSON.parse(operation.payload_json) : null
        if (payload?.customer_id) {
          this.db.prepare(`
            UPDATE customers
            SET dirty_at = NULL
            WHERE id = ? AND (dirty_at IS NULL OR dirty_at <= ?)
          `).run(payload.customer_id, operation.created_at)
        }
        if (payload?.account_transaction_id) {
          this.db.prepare(`
            UPDATE customer_deposit_transactions
            SET dirty_at = NULL
            WHERE id = ? AND (dirty_at IS NULL OR dirty_at <= ?)
          `).run(payload.account_transaction_id, operation.created_at)
        }

        if (payload?.payment_id) {
          this.db.prepare(`
            UPDATE supplier_payments
            SET dirty_at = NULL
            WHERE id = ? AND (dirty_at IS NULL OR dirty_at <= ?)
          `).run(payload.payment_id, operation.created_at)
        }
      } catch { /* ignore */ }
      this.clearDirtyProductsFromPayload(operation)
      return
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
