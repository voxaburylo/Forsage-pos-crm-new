import { randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { DEFAULT_TENANT_ID, type LocalBootstrapImportResult, type LocalBootstrapSnapshot, type LocalSyncOutboxOperation, type LocalSyncPullChanges, type LocalSyncPullResult, type LocalSyncPullState, type LocalSyncPushResult, type LocalSyncStuckOperation } from '../db/localTypes'
import { LocalBootstrapRepository } from './bootstrapRepository'
import { MAX_OUTBOX_ATTEMPTS, STUCK_OUTBOX_RETRY_MS } from './outboxPolicy'
import { LocalProblemRepository } from './problemRepository'
import { ChunkedSyncApplier } from './chunkedSyncApplier'
import { readServerResetGeneration } from './localTenantReset'

const SERVER_PULL_SCOPE = 'desktop_server_pull'
const LAST_REFERENCE_SYNC_KEY = 'desktop_last_reference_sync_at'
const CORRUPT_OUTBOX_RETRY_MS = 5 * 60_000
function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Каса свідомо працює без інтернету, тож обрив зв'язку — очікуваний стан, а не
 * проблема для журналу. Інакше журнал заповнився б однією й тією ж подією
 * за кожен магазинний день без мережі.
 */
const OFFLINE_ERROR_MARKERS = [
  'fetch failed', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN',
  'ETIMEDOUT', 'network', 'Немає зв', 'офлайн',
]

function isOfflineError(error: string | null | undefined): boolean {
  if (!error) return false
  const text = String(error).toLowerCase()
  return OFFLINE_ERROR_MARKERS.some((marker) => text.includes(marker.toLowerCase()))
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
  const addReference = (type: 'supplier' | 'product' | 'invoice' | 'brand' | 'category', value: unknown) => {
    if (typeof value === 'string' && value) keys.add(`${prefix}:reference:${type}:${value}`)
  }

  if (row.aggregate_type === 'supplier') addReference('supplier', row.aggregate_id)
  if (row.aggregate_type === 'product') addReference('product', row.aggregate_id)
  if (row.aggregate_type === 'supply_invoice') addReference('invoice', row.aggregate_id)
  // Бренд і категорія — такі самі залежності товару, як постачальник для
  // накладної. Без цього товар летить попереду свого бренда і падає на
  // зовнішньому ключі, а за ним валиться прихід і ревізія.
  if (row.aggregate_type === 'brand') addReference('brand', row.aggregate_id)
  if (row.aggregate_type === 'category') addReference('category', row.aggregate_id)
  addReference('brand', payload?.brand_id)
  addReference('category', payload?.category_id)

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
  private readonly problems: LocalProblemRepository

  constructor(private readonly db: LocalDatabase) {
    this.problems = new LocalProblemRepository(db)
    this.coalesceSupersededProductOperations()
    this.recoverLegacyReturnOutbox()
    this.recoverMissingCustomerVehicleOutbox()
    this.recoverOrphanProductDirtyFlags()
    this.recoverOrphanReturnedSaleDirtyFlags()
    this.recoverAcknowledgedDirtyFlags()
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
      reset_generation: readServerResetGeneration(this.db),
      last_error: row?.last_error ?? null,
    }
  }

  /**
   * Здоров'я синхронізації для індикатора в UI:
   *  - pending  — щойно створені, ще не відправлені;
   *  - retrying — впали, але ще будуть повторені швидко (attempts < MAX);
   *  - stuck    — вичерпали швидкі спроби (attempts >= MAX). Каса й далі
   *               пробує їх сама раз на STUCK_OUTBOX_RETRY_MS, тож зазвичай
   *               вони розсмоктуються без людини; лічильник потрібен власнику
   *               для звірки, а не касиру для чергування біля значка.
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

  /**
   * Операції, які вичерпали швидкі спроби. Каса повертається до них сама раз
   * на кілька годин, але список потрібен власнику: якщо рядок висить довго,
   * причина не лікується повтором і про неї треба знати.
   * Payload навмисно НЕ віддаємо: у накладній чи чеку він на сотні кілобайт,
   * а для екрана «застрягло» потрібні лише тип, час і текст помилки.
   */
  listStuck(limit = 100): LocalSyncStuckOperation[] {
    const maxRows = Math.max(1, Math.min(500, limit))
    return this.db.prepare(`
      SELECT sequence, operation_id, aggregate_type, aggregate_id,
             operation_type, created_at, attempts, last_error
      FROM sync_outbox
      WHERE status = 'failed' AND attempts >= ${MAX_OUTBOX_ATTEMPTS}
      ORDER BY sequence ASC
      LIMIT ?
    `).all(maxRows) as unknown as LocalSyncStuckOperation[]
  }

  /**
   * Ручний повтор для застряглих операцій: скидаємо лічильник спроб, і рядок
   * знову потрапляє у звичайну чергу. Викликається людиною з UI після того,
   * як усунено причину (роль, звʼязок, виправлені дані на сервері).
   *
   * Свідомо чіпаємо ЛИШЕ status='failed' з вичерпаними спробами. Рядки, які
   * ще ретраяться самі, чіпати не можна — скидання їхнього next_attempt_at
   * зламало б експоненційний backoff і влаштувало б шторм запитів.
   */
  retryStuck(sequences?: number[]): { retried: number } {
    const selected = Array.isArray(sequences)
      ? sequences.filter((value) => Number.isSafeInteger(value))
      : null
    if (selected && selected.length === 0) return { retried: 0 }

    return this.db.transaction(() => {
      const scope = selected
        ? `AND sequence IN (${selected.map(() => '?').join(',')})`
        : ''
      const statement = this.db.prepare(`
        UPDATE sync_outbox
        SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL
        WHERE status = 'failed' AND attempts >= ${MAX_OUTBOX_ATTEMPTS} ${scope}
      `)
      const result = selected ? statement.run(...selected) : statement.run()
      return { retried: Number(result.changes ?? 0) }
    })
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

  applyPullChangesChunked(changes: LocalSyncPullChanges): Promise<LocalSyncPullResult> {
    return new ChunkedSyncApplier(this.db).applyPullChanges(changes)
  }

  importSnapshotChunked(snapshot: LocalBootstrapSnapshot): Promise<LocalBootstrapImportResult> {
    return new ChunkedSyncApplier(this.db).importSnapshot(snapshot)
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
    // Вимкнений інтернет — це нормальна робота офлайн-каси, а не проблема.
    // У журнал потрапляє лише те, що не лікується відновленням зв'язку.
    if (!isOfflineError(error)) {
      this.problems.record({
        source: 'sync',
        code: 'sync.pull_failed',
        severity: 'warning',
        title: 'Каса не змогла завантажити зміни з сервера',
        detail: error,
      })
    }
  }

  listPending(limit = 50): LocalSyncOutboxOperation[] {
    const currentTime = nowIso()
    const maxOperations = Math.max(1, Math.min(100, limit))
    const failedRows = this.db.prepare(`
      SELECT sequence, operation_id, tenant_id, device_id, aggregate_type,
             aggregate_id, operation_type, payload_json, created_at,
             attempts, last_error, next_attempt_at, status
      FROM sync_outbox
      WHERE status = 'failed'
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
      WHERE status IN ('pending', 'failed')
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
    const rejected: number[] = []
    this.db.transaction(() => {
      const acknowledged: Array<{
        tenant_id: string
        aggregate_type: string
        aggregate_id: string
        operation_type: string
        payload_json: string | null
        created_at: string
      }> = []
      for (const result of results) {
        if (result.status === 'synced' || result.status === 'discarded') {
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
          // Discard is terminal, but the obsolete mutation was not accepted.
          if (operation && result.status === 'synced') acknowledged.push(operation)
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
        rejected.push(result.sequence)
      }
      // All statuses must be final before dirty flags are inspected. Otherwise
      // a reverse-ordered acknowledgement batch can leave a newer dirty_at orphaned.
      for (const operation of acknowledged) this.clearDirtyAfterPush(operation)
    })
    // Пишемо після коміту: журнал фіксує те, що вже реально сталося з чергою.
    this.recordRejectedOperations(rejected)
  }

  /**
   * Відхилена сервером операція — це або незбережений товар, або незарахований
   * прихід. На касі це видно лише як «кількість не та», тому кожне відхилення
   * лишає слід у журналі, а вичерпані спроби підвищують його до окремої проблеми.
   */
  private recordRejectedOperations(sequences: number[]): void {
    if (sequences.length === 0) return
    for (const sequence of sequences) {
      const row = this.db.prepare(`
        SELECT tenant_id, aggregate_type, aggregate_id, operation_type, attempts, last_error
        FROM sync_outbox
        WHERE sequence = ?
        LIMIT 1
      `).get(sequence) as {
        tenant_id: string
        aggregate_type: string
        aggregate_id: string
        operation_type: string
        attempts: number
        last_error: string | null
      } | undefined
      if (!row) continue

      const exhausted = row.attempts >= MAX_OUTBOX_ATTEMPTS
      this.problems.record({
        source: 'sync',
        code: exhausted ? 'sync.operation_stuck' : 'sync.operation_rejected',
        severity: exhausted ? 'error' : 'warning',
        title: exhausted
          ? `Операцію «${row.operation_type}» сервер так і не прийняв`
          : `Сервер відхилив операцію «${row.operation_type}»`,
        detail: row.last_error,
        entity_type: row.aggregate_type,
        entity_id: row.aggregate_id,
        context: { sequence, attempts: row.attempts, operation_type: row.operation_type },
        tenant_id: row.tenant_id,
      })
    }
  }

  markBatchFailed(sequences: number[], error: string): void {
    if (sequences.length === 0) return
    this.db.transaction(() => {
      for (const sequence of sequences) {
        // Затримку рахуємо по кожному рядку окремо: давно застрягле не має
        // повертатися через 15 секунд і ганяти сервер по колу.
        const nextAttemptAt = new Date(Date.now() + this.retryDelayMs(sequence)).toISOString()
        this.db.prepare(`
          UPDATE sync_outbox
          SET status = 'failed',
              attempts = attempts + 1,
              last_error = ?,
              next_attempt_at = ?
          WHERE sequence = ?
            AND status <> 'synced'
        `).run(error, nextAttemptAt, sequence)
      }
    })
    this.recordRejectedOperations(sequences)
  }


  private hasUnsyncedAggregate(tenantId: string, aggregateType: string, aggregateId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM sync_outbox
      WHERE tenant_id = ? AND aggregate_type = ? AND aggregate_id = ?
        AND status IN ('pending', 'failed', 'sending')
      LIMIT 1
    `).get(tenantId, aggregateType, aggregateId))
  }

  private clearDirtyAfterPush(operation: {
    tenant_id: string
    aggregate_type: string
    aggregate_id: string
    operation_type: string
    payload_json: string | null
    created_at: string
  }): void {
    // Acknowledging an older operation must never clear a dirty flag while a
    // newer retry for the same aggregate is still pending or failed.
    if (this.hasUnsyncedAggregate(operation.tenant_id, operation.aggregate_type, operation.aggregate_id)) return

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
      clearRow('sales', payload?.sale_id)
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
          OR last_error LIKE '%Кассов%смен%'
          OR last_error LIKE '%касов%змін%'
          OR last_error LIKE '%Касов%змін%'
          OR last_error LIKE '%SHIFT_REQUIRED%'
          OR last_error LIKE '%SHIFT_INVALID%'
          OR last_error LIKE '%сторнувати комісі%'
          OR last_error LIKE '%COMMISSION_REVERSAL_FAILED%'
        )
    `).run()
  }

  private recoverAcknowledgedDirtyFlags(): void {
    // Older builds sometimes acknowledged an outbox operation but crashed
    // before clearing the related dirty rows. Replaying only acknowledgements
    // whose timestamp is still present is safe: pending/failed work for the
    // same aggregate is checked again by clearDirtyAfterPush.
    const dirtyRows = this.db.prepare(`
      SELECT tenant_id, dirty_at FROM staff_users WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM brands WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM categories WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM suppliers WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM products WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM customers WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM customer_vehicles WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM customer_orders WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM customer_order_items WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM order_payments WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM shifts WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM sales WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM cash_operations WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM inventory_movements WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM inventory_sessions WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM supply_invoices WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM supply_invoice_items WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM supplier_payments WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM customer_deposit_transactions WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM customer_returns WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM bonus_transactions WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM warehouse_movements WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM stock_reserves WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM writeoffs WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM commission_rules WHERE dirty_at IS NOT NULL
      UNION ALL SELECT tenant_id, dirty_at FROM salary_payments WHERE dirty_at IS NOT NULL
    `).all() as Array<{ tenant_id: string; dirty_at: string }>
    if (dirtyRows.length === 0) return

    const dirtyKeys = new Set(dirtyRows.map((row) => `${row.tenant_id}:${row.dirty_at}`))
    const acknowledged = (this.db.prepare(`
      SELECT tenant_id, aggregate_type, aggregate_id, operation_type, payload_json, created_at
      FROM sync_outbox
      WHERE status = 'synced'
      ORDER BY sequence ASC
    `).all() as Array<{
      tenant_id: string
      aggregate_type: string
      aggregate_id: string
      operation_type: string
      payload_json: string | null
      created_at: string
    }>).filter((operation) => dirtyKeys.has(`${operation.tenant_id}:${operation.created_at}`))
    if (acknowledged.length === 0) return

    this.db.transaction(() => {
      for (const operation of acknowledged) this.clearDirtyAfterPush(operation)
    })
  }

  private recoverOrphanProductDirtyFlags(): void {
    // A row must stay dirty only while it still has work in the outbox. Older
    // builds could leave dirty_at behind after the last product operation had
    // already been acknowledged. Such a row then rejected every newer server
    // stock value forever. Clear only proven orphans and request a canonical
    // reference snapshot on the next pull.
    const result = this.db.prepare(`
      UPDATE products
      SET dirty_at = NULL
      WHERE dirty_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM sync_outbox o
          WHERE o.tenant_id = products.tenant_id
            AND o.aggregate_type = 'product'
            AND o.aggregate_id = products.id
            AND o.status <> 'synced'
        )
    `).run()
    if (result.changes > 0) {
      this.db.prepare('DELETE FROM app_meta WHERE key = ?').run(LAST_REFERENCE_SYNC_KEY)
    }
  }

  private recoverOrphanReturnedSaleDirtyFlags(): void {
    // Старі версії позначали продаж як returned, але не знімали його dirty_at
    // після успішного return.created. Чистимо лише рядки без будь-якої
    // незавершеної операції повернення або самого продажу.
    this.db.prepare(`
      UPDATE sales
      SET dirty_at = NULL
      WHERE status = 'returned'
        AND dirty_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM customer_returns r
          WHERE r.tenant_id = sales.tenant_id
            AND r.sale_id = sales.id
            AND r.status = 'completed'
            AND r.deleted_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM sync_outbox o
          WHERE o.tenant_id = sales.tenant_id
            AND o.status IN ('pending', 'sending', 'failed')
            AND (
              (o.aggregate_type = 'sale' AND o.aggregate_id = sales.id)
              OR (
                o.operation_type = 'return.created'
                AND o.aggregate_id IN (
                  SELECT r.id FROM customer_returns r
                  WHERE r.tenant_id = sales.tenant_id AND r.sale_id = sales.id
                )
              )
            )
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
    // Рахуємо за станом ПІСЛЯ цієї невдачі: інакше на самому переході в
    // «застрягло» операція ще раз пішла б за швидким розкладом.
    // Після вичерпання швидких спроб не здаємось, а переходимо на рідкісні:
    // причина відмови часто на сервері, і коли її виправлять, черга має
    // розібратися сама, без участі касира.
    if (attempts + 1 >= MAX_OUTBOX_ATTEMPTS) return STUCK_OUTBOX_RETRY_MS
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
