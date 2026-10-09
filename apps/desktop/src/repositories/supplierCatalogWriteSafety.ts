import { isDeepStrictEqual } from 'node:util'
import type { LocalDatabase } from '../db/localDatabase'

type Row = Record<string, any>
type WriteResult = { changes: number | bigint; lastInsertRowid: number | bigint }
export const catalogWriteConflict = () => new Error(
  'Прайс не збережено повністю. Зміни цієї спроби скасовано; попередні дані залишено. Повторіть після перевірки.'
)

/**
 * Only used within a synchronous BEGIN IMMEDIATE transaction, before COMMIT.
 * Expected rows come from inputs/pre-write state, never from a post-write read.
 * The row budget also detects unplanned trigger writes to other scopes/stock.
 * These catalog paths have no intentional trigger writes, REPLACE or cascades.
 */
export class SupplierCatalogWriteGuard {
  private readonly before: number
  private writes = 0
  private readonly items = new Map<string, Row>()
  private readonly imports = new Map<string, Row>()
  private readonly events = new Map<string, Row>()

  constructor(private readonly db: LocalDatabase) { this.before = this.totalChanges() }

  item(id: string): Row | undefined {
    const planned = this.items.get(id)
    if (planned) return planned
    const row = this.db.prepare('SELECT * FROM supplier_price_items WHERE id=?').get(id)
    if (!row) return undefined
    const before = { ...row }
    this.items.set(id, before)
    return before
  }
  import(id: string): Row | undefined {
    const planned = this.imports.get(id)
    if (planned) return planned
    const row = this.db.prepare('SELECT * FROM supplier_price_imports WHERE id=?').get(id)
    if (!row) return undefined
    const before = { ...row }
    this.imports.set(id, before)
    return before
  }
  expectItem(row: Row): void { this.items.set(row.id, { ...row }) }
  expectImport(row: Row): void { this.imports.set(row.id, { ...row }) }
  expectEvent(row: Row): void { this.events.set(row.operation_id, { ...row }) }

  written(result: WriteResult, expected = 1): void {
    if (!Number.isSafeInteger(expected) || expected < 0 || Number(result.changes) !== expected)
      throw catalogWriteConflict()
    this.writes += expected
  }

  verify(): void { this.verifyWrites(0) }

  // idempotentMutation independently verifies this one app_meta receipt insert.
  verifyAfterReceipt(): void { this.verifyWrites(1) }

  private verifyWrites(receiptWrites: number): void {
    if (this.totalChanges() - this.before !== this.writes + receiptWrites) throw catalogWriteConflict()
    this.verifyStoredRows()
  }

  // Recheck affected rows after other legitimate work in the enclosing transaction.
  verifyStoredRows(): void {
    this.verifyRows('supplier_price_items', 'id', this.items)
    this.verifyRows('supplier_price_imports', 'id', this.imports)
    this.verifyRows('sync_outbox', 'operation_id', this.events)
  }

  private verifyRows(table: string, key: string, expected: Map<string, Row>): void {
    if (!expected.size) return
    // One bounded query per table, not a full shop/product scan per imported row.
    const actual = this.db.prepare(
      'SELECT * FROM ' + table + ' WHERE ' + key + ' IN (SELECT value FROM json_each(?))'
    ).all(JSON.stringify([...expected.keys()])) as Row[]
    if (actual.length !== expected.size
      || actual.some(row => !isDeepStrictEqual({ ...row }, expected.get(row[key]))))
      throw catalogWriteConflict()
  }

  private totalChanges(): number {
    const count = Number((this.db.prepare('SELECT total_changes() n').get() as { n: number }).n)
    if (!Number.isSafeInteger(count) || count < 0) throw catalogWriteConflict()
    return count
  }
}
