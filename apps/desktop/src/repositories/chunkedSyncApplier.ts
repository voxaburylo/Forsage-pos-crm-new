import type { LocalDatabase } from '../db/localDatabase'
import {
  DEFAULT_TENANT_ID,
  type LocalBootstrapImportResult,
  type LocalBootstrapSnapshot,
  type LocalSyncPullChanges,
  type LocalSyncPullResult,
} from '../db/localTypes'
import { LocalBootstrapRepository } from './bootstrapRepository'
import { normalizeReferenceDeletes } from './referenceSyncAdapter'
import { bootstrapSnapshotToPullChanges, createPullChangeChunks } from './syncPullPlanner'
import { resetLocalTenantData, writeServerResetGeneration } from './localTenantReset'

const SERVER_PULL_SCOPE = 'desktop_server_pull'
const LAST_REFERENCE_SYNC_KEY = 'desktop_last_reference_sync_at'
const CLEANUP_BATCH_SIZE = 100

type PullCounts = LocalSyncPullResult['counts']
type CountKey = keyof PullCounts

function nowIso(): string {
  return new Date().toISOString()
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function addCounts(target: Partial<PullCounts>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    const countKey = key as CountKey
    target[countKey] = Number(target[countKey] ?? 0) + Number(value ?? 0)
  }
}

function increment(target: Partial<PullCounts>, key: CountKey, value: number): void {
  target[key] = Number(target[key] ?? 0) + value
}

function parts<T>(rows: T[], size = CLEANUP_BATCH_SIZE): T[][] {
  const result: T[][] = []
  for (let offset = 0; offset < rows.length; offset += size) {
    result.push(rows.slice(offset, offset + size))
  }
  return result
}

/**
 * Applies a downloaded response in bounded transactions. The HTTP payload is
 * retained in memory for the whole operation, so a large response is never
 * discarded and downloaded again merely because it exceeds a row threshold.
 */
export class ChunkedSyncApplier {
  constructor(private readonly db: LocalDatabase) {}

  async applyPullChanges(changes: LocalSyncPullChanges): Promise<LocalSyncPullResult> {
    if (!changes.cursor) throw new Error('LOCAL_PULL_CURSOR_REQUIRED')
    return this.apply(changes)
  }

  async importSnapshot(snapshot: LocalBootstrapSnapshot): Promise<LocalBootstrapImportResult> {
    const importedAt = nowIso()
    const normalizedSnapshot = {
      ...snapshot,
      exported_at: snapshot.exported_at || importedAt,
    }
    const result = await this.apply(bootstrapSnapshotToPullChanges(normalizedSnapshot), {
      bootstrap: true,
      appliedAt: importedAt,
    })
    return {
      imported_at: result.applied_at,
      tenant_id: normalizedSnapshot.tenant_id,
      counts: result.counts,
    }
  }

  private async apply(
    changes: LocalSyncPullChanges,
    options: { bootstrap?: boolean; appliedAt?: string } = {},
  ): Promise<LocalSyncPullResult> {
    const appliedAt = options.appliedAt ?? nowIso()
    const tenantId = changes.tenant_id ?? DEFAULT_TENANT_ID
    const importer = new LocalBootstrapRepository(this.db)
    const counts: Partial<PullCounts> = {}

    this.markPullAttempt(appliedAt)
    if (changes.reset_required === true) {
      resetLocalTenantData(
        this.db,
        tenantId,
        Number(changes.reset_generation ?? 0),
        appliedAt,
      )
      return {
        applied_at: appliedAt,
        cursor: changes.cursor,
        counts: counts as PullCounts,
      }
    }
    for (const chunk of createPullChangeChunks(changes)) {
      const result = importer.applySyncChanges(tenantId, chunk)
      addCounts(counts, result.counts)
      await yieldToEventLoop()
    }

    await this.applyReferenceDeleteDeltas(tenantId, changes, appliedAt, counts)
    if (changes.references_included === true) {
      await this.reconcileReferenceSnapshots(tenantId, changes, counts)
    }
    await this.pruneDeclaredSnapshots(tenantId, changes, appliedAt, counts)

    this.finalizeCursor(tenantId, changes, appliedAt, counts, options.bootstrap === true)
    return {
      applied_at: appliedAt,
      cursor: changes.cursor,
      counts: counts as PullCounts,
    }
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

  private finalizeCursor(
    tenantId: string,
    changes: LocalSyncPullChanges,
    appliedAt: string,
    counts: Partial<PullCounts>,
    bootstrap: boolean,
  ): void {
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO sync_state(scope, pull_cursor, last_attempt_at, last_success_at, last_error, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?)
        ON CONFLICT(scope) DO UPDATE SET
          pull_cursor = excluded.pull_cursor,
          last_attempt_at = excluded.last_attempt_at,
          last_success_at = excluded.last_success_at,
          last_error = NULL,
          updated_at = excluded.updated_at
      `).run(SERVER_PULL_SCOPE, changes.cursor, appliedAt, appliedAt, appliedAt)

      if (changes.references_included === true) {
        this.db.prepare(`
          INSERT INTO app_meta(key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `).run(LAST_REFERENCE_SYNC_KEY, JSON.stringify(appliedAt), appliedAt)
      }

      if (Number.isSafeInteger(changes.reset_generation)) {
        writeServerResetGeneration(
          this.db,
          Number(changes.reset_generation),
          appliedAt,
        )
      }
      if (bootstrap) {
        this.db.prepare(`
          INSERT INTO app_meta(key, value_json, updated_at)
          VALUES ('last_bootstrap_snapshot', ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `).run(JSON.stringify({ exported_at: changes.cursor, counts }), appliedAt)
      }
    })
  }

  private async applyReferenceDeleteDeltas(
    tenantId: string,
    changes: LocalSyncPullChanges,
    deletedAt: string,
    counts: Partial<PullCounts>,
  ): Promise<void> {
    const delta = normalizeReferenceDeletes(changes)
    const productTables: Array<{
      table: 'product_barcodes' | 'product_aliases' | 'product_cross_numbers'
      ids: string[]
      count: CountKey
    }> = [
      { table: 'product_barcodes', ids: delta.productBarcodeIds, count: 'product_barcodes' },
      { table: 'product_aliases', ids: delta.productAliasIds, count: 'product_aliases' },
      { table: 'product_cross_numbers', ids: delta.productCrossNumberIds, count: 'product_cross_numbers' },
    ]
    for (const spec of productTables) {
      for (const batch of parts(spec.ids)) {
        let changed = 0
        this.db.transaction(() => {
          const statement = this.db.prepare(`
            DELETE FROM ${spec.table}
            WHERE tenant_id = ? AND id = ?
              AND NOT EXISTS (
                SELECT 1 FROM products p
                WHERE p.id = ${spec.table}.product_id
                  AND p.tenant_id = ? AND p.dirty_at IS NOT NULL
              )
          `)
          for (const id of batch) changed += Number(statement.run(tenantId, id, tenantId).changes)
        })
        increment(counts, spec.count, changed)
        await yieldToEventLoop()
      }
    }

    for (const batch of parts(delta.customerVehicleIds)) {
      let changed = 0
      this.db.transaction(() => {
        const statement = this.db.prepare(`
          UPDATE customer_vehicles
          SET deleted_at = ?, updated_at = ?, remote_updated_at = ?
          WHERE tenant_id = ? AND id = ? AND dirty_at IS NULL AND deleted_at IS NULL
        `)
        for (const id of batch) {
          changed += Number(statement.run(deletedAt, deletedAt, deletedAt, tenantId, id).changes)
        }
      })
      increment(counts, 'customer_vehicles', changed)
      await yieldToEventLoop()
    }

    await this.markCatalogIdsDeleted('categories', tenantId, delta.categoryIds, deletedAt, counts, 'deleted_categories')
    await this.markCatalogIdsDeleted('brands', tenantId, delta.brandIds, deletedAt, counts, 'deleted_brands')
  }

  private async markCatalogIdsDeleted(
    table: 'categories' | 'brands',
    tenantId: string,
    ids: string[],
    deletedAt: string,
    counts: Partial<PullCounts>,
    countKey: 'deleted_categories' | 'deleted_brands',
  ): Promise<void> {
    for (const batch of parts(ids)) {
      let changed = 0
      this.db.transaction(() => {
        const statement = this.db.prepare(`
          UPDATE ${table}
          SET deleted_at = ?, updated_at = ?, remote_updated_at = ?
          WHERE tenant_id = ? AND id = ? AND dirty_at IS NULL AND deleted_at IS NULL
        `)
        for (const id of batch) {
          changed += Number(statement.run(deletedAt, deletedAt, deletedAt, tenantId, id).changes)
        }
      })
      increment(counts, countKey, changed)
      await yieldToEventLoop()
    }
  }

  private async reconcileReferenceSnapshots(
    tenantId: string,
    changes: LocalSyncPullChanges,
    counts: Partial<PullCounts>,
  ): Promise<void> {
    await this.pruneReferenceTable(
      'product_barcodes', 'barcode', tenantId,
      new Set((changes.product_barcodes ?? []).map((row: any) => String(row?.barcode ?? '')).filter(Boolean)),
      counts, 'product_barcodes',
    )
    await this.pruneReferenceTable(
      'product_aliases', 'id', tenantId,
      new Set((changes.product_aliases ?? []).map((row: any) => String(row?.id ?? '')).filter(Boolean)),
      counts, 'product_aliases',
    )
    await this.pruneReferenceTable(
      'product_cross_numbers', 'id', tenantId,
      new Set((changes.product_cross_numbers ?? []).map((row: any) => String(row?.id ?? '')).filter(Boolean)),
      counts, 'product_cross_numbers',
    )

    const incomingVehicles = new Set(
      (changes.customer_vehicles ?? []).map((row: any) => String(row?.id ?? '')).filter(Boolean),
    )
    const staleVehicles = (this.db.prepare(`
      SELECT id FROM customer_vehicles
      WHERE tenant_id = ? AND dirty_at IS NULL
    `).all(tenantId) as Array<{ id: string }>).filter((row) => !incomingVehicles.has(row.id))
    for (const batch of parts(staleVehicles)) {
      let changed = 0
      this.db.transaction(() => {
        const statement = this.db.prepare(
          'DELETE FROM customer_vehicles WHERE tenant_id = ? AND id = ? AND dirty_at IS NULL',
        )
        for (const row of batch) changed += Number(statement.run(tenantId, row.id).changes)
      })
      increment(counts, 'customer_vehicles', changed)
      await yieldToEventLoop()
    }
  }

  private async pruneReferenceTable(
    table: 'product_barcodes' | 'product_aliases' | 'product_cross_numbers',
    identityColumn: 'id' | 'barcode',
    tenantId: string,
    incoming: Set<string>,
    counts: Partial<PullCounts>,
    countKey: 'product_barcodes' | 'product_aliases' | 'product_cross_numbers',
  ): Promise<void> {
    const localRows = this.db.prepare(`
      SELECT r.${identityColumn} AS identity
      FROM ${table} r
      JOIN products p ON p.id = r.product_id AND p.tenant_id = r.tenant_id
      WHERE r.tenant_id = ? AND p.dirty_at IS NULL
    `).all(tenantId) as Array<{ identity: string }>
    const stale = localRows.filter((row) => !incoming.has(String(row.identity)))
    for (const batch of parts(stale)) {
      let changed = 0
      this.db.transaction(() => {
        const statement = this.db.prepare(`
          DELETE FROM ${table}
          WHERE tenant_id = ? AND ${identityColumn} = ?
            AND NOT EXISTS (
              SELECT 1 FROM products p
              WHERE p.id = ${table}.product_id
                AND p.tenant_id = ? AND p.dirty_at IS NOT NULL
            )
        `)
        for (const row of batch) {
          changed += Number(statement.run(tenantId, row.identity, tenantId).changes)
        }
      })
      increment(counts, countKey, changed)
      await yieldToEventLoop()
    }
  }

  private async pruneDeclaredSnapshots(
    tenantId: string,
    changes: LocalSyncPullChanges,
    deletedAt: string,
    counts: Partial<PullCounts>,
  ): Promise<void> {
    if (changes.catalog_structure_snapshot_included === true) {
      await this.pruneSnapshotTable('categories', tenantId, changes.categories, deletedAt, counts, 'deleted_categories')
      await this.pruneSnapshotTable('brands', tenantId, changes.brands, deletedAt, counts, 'deleted_brands')
    }
    if (changes.staff_snapshot_included === true) {
      await this.pruneSnapshotTable('staff_users', tenantId, changes.staff, deletedAt, counts, 'deleted_staff', true)
    }
    if (changes.commission_rules_snapshot_included === true) {
      await this.pruneSnapshotTable(
        'commission_rules', tenantId, changes.commission_rules, deletedAt, counts, 'deleted_commission_rules',
      )
    }
    if (changes.salary_payments_snapshot_included === true) {
      await this.pruneSnapshotTable(
        'salary_payments', tenantId, changes.salary_payments, deletedAt, counts, 'deleted_salary_payments',
      )
    }
    if (changes.stock_reserves_snapshot_included === true) {
      await this.pruneSnapshotTable(
        'stock_reserves', tenantId, changes.stock_reserves, deletedAt, counts, 'deleted_stock_reserves',
      )
    }
  }

  private async pruneSnapshotTable(
    table: 'categories' | 'brands' | 'staff_users' | 'commission_rules' | 'salary_payments' | 'stock_reserves',
    tenantId: string,
    remoteRows: any[] | undefined,
    deletedAt: string,
    counts: Partial<PullCounts>,
    countKey: CountKey,
    deactivate = false,
  ): Promise<void> {
    const incoming = new Set((remoteRows ?? []).map((row) => String(row?.id ?? '')).filter(Boolean))
    const stale = (this.db.prepare(`
      SELECT id FROM ${table}
      WHERE tenant_id = ? AND dirty_at IS NULL AND deleted_at IS NULL
    `).all(tenantId) as Array<{ id: string }>).filter((row) => !incoming.has(row.id))
    for (const batch of parts(stale)) {
      let changed = 0
      this.db.transaction(() => {
        const statement = this.db.prepare(`
          UPDATE ${table}
          SET deleted_at = ?, updated_at = ?, remote_updated_at = ?${deactivate ? ', is_active = 0' : ''}
          WHERE tenant_id = ? AND id = ? AND dirty_at IS NULL AND deleted_at IS NULL
        `)
        for (const row of batch) {
          changed += Number(statement.run(deletedAt, deletedAt, deletedAt, tenantId, row.id).changes)
        }
      })
      increment(counts, countKey, changed)
      await yieldToEventLoop()
    }
  }
}
