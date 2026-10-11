import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID, type LocalProductUpsert } from '../src/db/localTypes'
import { LOCAL_MIGRATIONS } from '../src/db/schema'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSyncRepository } from '../src/repositories/syncRepository'

const START = '2026-10-11T10:00:00.000Z'
const PRODUCT_ID = 'producer-ordering-product'
const REPLACED = 'Замінено новішою версією товару'
const INITIAL: LocalProductUpsert = {
  id: PRODUCT_ID,
  tenant_id: DEFAULT_TENANT_ID,
  sku: 'PRODUCER-ORDERING',
  name: 'Initial catalog name',
  qty_on_hand: 2,
  purchase_price: 100,
  retail_price: 150,
}

type OutboxRow = {
  sequence: number
  operation_id: string
  tenant_id: string
  device_id: string
  aggregate_type: string
  aggregate_id: string
  operation_type: string
  payload_json: string
  status: 'pending' | 'failed' | 'sending' | 'synced'
  attempts: number
  next_attempt_at: string | null
  last_error: string | null
  created_at: string
  synced_at: string | null
}

describe('product outbox producer ordering across restart', () => {
  let sqlite: DatabaseSync
  let db: LocalDatabase
  let catalog: LocalCatalogRepository

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(START))
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    for (const migration of LOCAL_MIGRATIONS) sqlite.exec(migration.sql)
    function transaction<T>(work: () => T): T {
      if (sqlite.isTransaction) return work()
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        const result = work()
        sqlite.exec('COMMIT')
        return result
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    }
    // Real repositories and schema, but an exclusively in-memory connection:
    // no LocalDatabase filesystem constructor, application, server or working DB.
    db = {
      deviceId: 'producer-ordering-memory-device',
      prepare: (sql: string) => sqlite.prepare(sql),
      transaction,
      readSnapshot: transaction,
    } as unknown as LocalDatabase
    catalog = new LocalCatalogRepository(db)
    // Seed an existing card without queueing it; every operation below comes
    // from the real public producer, not fabricated outbox payloads.
    catalog.upsertProduct(INITIAL)
    advanceTime()
  })

  afterEach(() => {
    sqlite?.close()
    vi.useRealTimers()
  })

  function advanceTime(): void {
    vi.setSystemTime(new Date(Date.now() + 1000))
  }

  function rows(): OutboxRow[] {
    return sqlite.prepare(`SELECT * FROM sync_outbox
      WHERE tenant_id = ? AND aggregate_type = 'product' AND aggregate_id = ?
      ORDER BY sequence`).all(DEFAULT_TENANT_ID, PRODUCT_ID) as OutboxRow[]
  }

  function payload(row: OutboxRow): LocalProductUpsert {
    return JSON.parse(row.payload_json) as LocalProductUpsert
  }

  function expectRetired(original: OutboxRow, actual = rows().find(row => row.sequence === original.sequence), retiredAt = new Date().toISOString()): void {
    // Retirement may change delivery metadata, never the historical request
    // identity, contents, creation time or number of previous attempts.
    expect(actual).toMatchObject({
      sequence: original.sequence, operation_id: original.operation_id,
      tenant_id: original.tenant_id, device_id: original.device_id,
      aggregate_type: original.aggregate_type, aggregate_id: original.aggregate_id,
      operation_type: original.operation_type, payload_json: original.payload_json,
      created_at: original.created_at, attempts: original.attempts,
      status: 'synced', synced_at: retiredAt, next_attempt_at: null, last_error: REPLACED,
    })
  }

  function businessSnapshot(): Record<string, unknown> {
    const tables = sqlite.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name <> 'sync_outbox' ORDER BY name`).all() as Array<{ name: string }>
    return Object.fromEntries(tables.map(({ name }) => [
      name, sqlite.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all(),
    ]))
  }

  function fail(row: OutboxRow): void {
    sqlite.prepare(`UPDATE sync_outbox SET status = 'failed', attempts = 3,
      next_attempt_at = ?, last_error = 'temporary failure' WHERE sequence = ?`)
      .run('2026-12-01T10:00:00.000Z', row.sequence)
  }

  function ordinary(name = INITIAL.name, retailPrice = INITIAL.retail_price): void {
    // A stale editor must also not overwrite the correction's stock of 5.
    catalog.saveProduct({ ...INITIAL, name, retail_price: retailPrice, qty_on_hand: 99 })
  }

  it.each(['pending', 'failed'] as const)('preserves a newer card edit after a correction and a full restart (%s older ordinary)', olderStatus => {
    ordinary()
    if (olderStatus === 'failed') fail(rows()[0])
    const oldest = rows()[0]
    advanceTime()
    catalog.saveProduct({ ...INITIAL, qty_on_hand: 5, stock_correction: true })
    const correction = rows().find(row => payload(row).stock_correction === true)!
    expect(rows().find(row => row.sequence === oldest.sequence)).toEqual(oldest)
    advanceTime()
    ordinary('LATEST catalog name', 350)

    const beforeRestart = rows()
    const latest = beforeRestart.find(row => payload(row).name === 'LATEST catalog name')!
    // Regression: rewriting the older ordinary sequence makes the constructor
    // discard this newer edit in favour of the stale correction payload.
    expect(latest.sequence).toBeGreaterThan(correction.sequence)
    expectRetired(oldest, beforeRestart.find(row => row.sequence === oldest.sequence))
    expect(beforeRestart.find(row => row.sequence === correction.sequence)).toEqual(correction)
    expect(payload(latest)).toMatchObject({ name: 'LATEST catalog name', retail_price: 350, qty_on_hand: 5 })
    expect(payload(latest).stock_correction).not.toBe(true)

    const businessBefore = businessSnapshot()
    const repository = new LocalSyncRepository(db)
    expect(businessSnapshot()).toEqual(businessBefore)
    const active = rows().filter(row => row.status === 'pending' || row.status === 'failed')
    expect(active.map(row => row.sequence)).toEqual([correction.sequence, latest.sequence])
    expect(active.find(row => row.sequence === correction.sequence)).toEqual(correction)
    expect(rows().find(row => row.sequence === oldest.sequence)?.status).toBe('synced')

    const outgoing = repository.listPending(100)
    expect(outgoing.map(operation => operation.sequence)).toEqual([correction.sequence, latest.sequence])
    expect(outgoing[0].payload).toMatchObject({ name: INITIAL.name, retail_price: 150, qty_on_hand: 5, stock_correction: true })
    expect(outgoing[1].payload).toMatchObject({ name: 'LATEST catalog name', retail_price: 350, qty_on_hand: 5 })
    expect(outgoing[1].payload.stock_correction).not.toBe(true)
    for (const operation of outgoing) {
      expect(operation.payload.local_balance_snapshot.products).toEqual([{ id: PRODUCT_ID, qty_on_hand: 5 }])
    }
    const afterRestart = rows()
    new LocalSyncRepository(db)
    expect(rows()).toEqual(afterRestart)
    expect(businessSnapshot()).toEqual(businessBefore)
  })

  it.each(['pending', 'failed'] as const)('preserves the identity and payload of an older ordinary %s operation', status => {
    ordinary()
    if (status === 'failed') fail(rows()[0])
    const original = rows()[0]
    advanceTime()
    ordinary('LATEST catalog name', 350)

    expect(rows()).toHaveLength(2)
    expectRetired(original, rows()[0])
    const latest = rows()[1]
    expect(latest.sequence).toBeGreaterThan(original.sequence)
    expect(latest.operation_id).not.toBe(original.operation_id)
    expect(latest).toMatchObject({
      status: 'pending', attempts: 0, next_attempt_at: null, last_error: null,
    })
    expect(latest.created_at).toBe(new Date().toISOString())
    expect(payload(latest)).toMatchObject({ name: 'LATEST catalog name', retail_price: 350, qty_on_hand: 2 })
    expect(payload(latest).stock_correction).not.toBe(true)
    const businessBefore = businessSnapshot()
    const repository = new LocalSyncRepository(db)
    expect(repository.listPending(100).map(operation => operation.sequence)).toEqual([latest.sequence])
    expect(businessSnapshot()).toEqual(businessBefore)
  })

  it.each(['pending', 'failed'] as const)('does not acknowledge a newer edit when an old %s request receives a late success', transportStatus => {
    ordinary()
    const repository = new LocalSyncRepository(db)
    const transmitted = repository.listPending(100)[0]
    expect(transmitted.payload).toMatchObject({ name: INITIAL.name, retail_price: 150 })
    // A failed request may have reached the server even if its acknowledgement
    // was lost. Its operation_id must never be reused with different contents.
    if (transportStatus === 'failed') fail(rows()[0])
    const original = rows()[0]
    advanceTime()
    ordinary('LATEST catalog name', 350)
    const beforeAcknowledgement = rows()
    const latest = beforeAcknowledgement.find(row => payload(row).name === 'LATEST catalog name')!
    const businessBefore = businessSnapshot()

    repository.applyPushResults([{
      sequence: transmitted.sequence,
      operation_id: transmitted.operation_id,
      status: 'synced',
    }])

    const active = rows().filter(row => row.status === 'pending' || row.status === 'failed')
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ sequence: latest.sequence, operation_id: latest.operation_id, status: 'pending' })
    expect(payload(active[0])).toMatchObject({ name: 'LATEST catalog name', retail_price: 350, qty_on_hand: 2 })
    expect(latest.sequence).toBeGreaterThan(transmitted.sequence)
    expect(latest.operation_id).not.toBe(transmitted.operation_id)
    expectRetired(original, beforeAcknowledgement.find(row => row.sequence === original.sequence))
    expect(rows().find(row => row.sequence === original.sequence)).toMatchObject({ status: 'synced', payload_json: original.payload_json })
    expect(repository.listPending(100).map(operation => operation.sequence)).toEqual([latest.sequence])
    expect(businessSnapshot()).toEqual(businessBefore)
  })

  it('does not reuse an ordinary version from before a deletion when the same card is saved again', () => {
    ordinary()
    const oldest = rows()[0]
    advanceTime()
    catalog.deleteProduct(PRODUCT_ID)
    const deletion = rows().find(row => row.operation_type === 'product.deleted')!
    advanceTime()
    ordinary('Restored latest catalog name', 450)

    const latest = rows().find(row => payload(row).name === 'Restored latest catalog name')!
    expect(latest.sequence).toBeGreaterThan(deletion.sequence)
    expect(rows().find(row => row.sequence === oldest.sequence)?.payload_json).toBe(oldest.payload_json)
    expect(rows().find(row => row.sequence === deletion.sequence)).toEqual(deletion)
    const businessBefore = businessSnapshot()
    const repository = new LocalSyncRepository(db)
    const outgoing = repository.listPending(100)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]).toMatchObject({ sequence: latest.sequence, operation_type: 'product.upsert' })
    expect(outgoing[0].payload).toMatchObject({ name: 'Restored latest catalog name', retail_price: 450, qty_on_hand: 0 })
    expect(catalog.findById(PRODUCT_ID)).toMatchObject({ name: 'Restored latest catalog name', retail_price: 450, qty_on_hand: 0 })
    expect(businessSnapshot()).toEqual(businessBefore)
  })

  it('appends after an in-flight correction without mutating that payload or reusing an earlier ordinary version', () => {
    ordinary()
    const oldest = rows()[0]
    advanceTime()
    catalog.saveProduct({ ...INITIAL, qty_on_hand: 5, stock_correction: true })
    const correction = rows().find(row => payload(row).stock_correction === true)!
    // Synthetic transport state only: never send anything to a real server.
    sqlite.prepare("UPDATE sync_outbox SET status = 'sending' WHERE sequence = ?").run(correction.sequence)
    const sending = rows().find(row => row.sequence === correction.sequence)!
    advanceTime()
    ordinary('LATEST catalog name', 350)

    const latest = rows().find(row => payload(row).name === 'LATEST catalog name')!
    expect(latest.sequence).toBeGreaterThan(sending.sequence)
    expect(rows().find(row => row.sequence === sending.sequence)).toEqual(sending)
    expect(rows().find(row => row.sequence === oldest.sequence)?.payload_json).toBe(oldest.payload_json)
    const businessBefore = businessSnapshot()
    const repository = new LocalSyncRepository(db)
    expect(rows().find(row => row.sequence === sending.sequence)).toEqual(sending)
    const outgoing = repository.listPending(100)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0].sequence).toBe(latest.sequence)
    expect(outgoing[0].payload).toMatchObject({ name: 'LATEST catalog name', retail_price: 350, qty_on_hand: 5 })
    expect(outgoing[0].payload.stock_correction).not.toBe(true)
    expect(businessSnapshot()).toEqual(businessBefore)
  })

  it('makes a corrected ordinary edit sendable immediately without restarting after an older ordinary failure', () => {
    const repository = new LocalSyncRepository(db)
    ordinary()
    fail(rows()[0])
    const failed = rows()[0]
    expect(repository.listPending(100)).toEqual([])
    advanceTime()
    ordinary('LATEST catalog name', 350)

    expectRetired(failed)
    const latest = rows().find(row => row.status === 'pending')!
    expect(latest.sequence).toBeGreaterThan(failed.sequence)
    const businessBefore = businessSnapshot()
    const outgoing = repository.listPending(100)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0].sequence).toBe(latest.sequence)
    expect(outgoing[0].payload).toMatchObject({ name: 'LATEST catalog name', retail_price: 350, qty_on_hand: 2 })
    expect(businessSnapshot()).toEqual(businessBefore)
  })

  it('keeps a failed explicit correction as a retry barrier rather than retiring it with ordinary edits', () => {
    const repository = new LocalSyncRepository(db)
    ordinary()
    const oldest = rows()[0]
    advanceTime()
    catalog.saveProduct({ ...INITIAL, qty_on_hand: 5, stock_correction: true })
    const correction = rows().find(row => payload(row).stock_correction === true)!
    fail(correction)
    const failed = rows().find(row => row.sequence === correction.sequence)!
    advanceTime()
    ordinary('LATEST catalog name', 350)

    expectRetired(oldest)
    expect(rows().find(row => row.sequence === failed.sequence)).toEqual(failed)
    const latest = rows().find(row => row.status === 'pending')!
    expect(latest.sequence).toBeGreaterThan(failed.sequence)
    const businessBefore = businessSnapshot()
    expect(repository.listPending(100)).toEqual([])
    expect(businessSnapshot()).toEqual(businessBefore)

    vi.setSystemTime(new Date('2026-12-01T10:00:01.000Z'))
    const retry = repository.listPending(100)
    expect(retry.map(operation => operation.sequence)).toEqual([failed.sequence])
    expect(retry[0].payload).toMatchObject({ qty_on_hand: 5, stock_correction: true })
    repository.applyPushResults([{ sequence: failed.sequence, operation_id: failed.operation_id, status: 'synced' }])
    expect(repository.listPending(100).map(operation => operation.sequence)).toEqual([latest.sequence])
    expect(businessSnapshot()).toEqual(businessBefore)
  })

  it.each(['applyPushResults', 'markBatchFailed'] as const)('ignores a late %s failure for a retired ordinary request without resurrecting it or logging a false problem', method => {
    const repository = new LocalSyncRepository(db)
    ordinary()
    const transmitted = repository.listPending(100)[0]
    const original = rows()[0]
    advanceTime()
    ordinary('LATEST catalog name', 350)
    expectRetired(original)
    const before = rows()
    const businessBefore = businessSnapshot()
    const problemsBefore = sqlite.prepare('SELECT * FROM problem_log ORDER BY rowid').all()
    advanceTime()

    if (method === 'applyPushResults') {
      repository.applyPushResults([{
        sequence: transmitted.sequence, operation_id: transmitted.operation_id,
        status: 'failed', error: 'late transport failure',
      }])
    } else {
      repository.markBatchFailed([transmitted.sequence], 'late transport failure')
    }

    expect(rows()).toEqual(before)
    expect(sqlite.prepare('SELECT * FROM problem_log ORDER BY rowid').all()).toEqual(problemsBefore)
    expect(businessSnapshot()).toEqual(businessBefore)
    const outgoing = repository.listPending(100)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0].payload).toMatchObject({ name: 'LATEST catalog name', retail_price: 350 })
    expect(outgoing[0].sequence).not.toBe(transmitted.sequence)
  })

  it('retires only ordinary operations for the same product and tenant', () => {
    ordinary()
    const original = rows()[0]
    const otherProduct = 'producer-ordering-independent-product'
    catalog.saveProduct({ ...INITIAL, id: otherProduct, sku: 'INDEPENDENT-PRODUCT', name: 'Independent product' })
    // Outbox permits this legacy/anomalous cross-tenant reference even though
    // products.id is globally unique. Producer cleanup must not widen its scope.
    sqlite.prepare(`INSERT INTO sync_outbox (
      operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
      operation_type, payload_json, status, attempts, created_at
    ) VALUES (?, ?, ?, 'product', ?, 'product.upsert', ?, 'failed', 3, ?)`)
      .run('independent-tenant-operation', 'independent-tenant', 'independent-device', PRODUCT_ID,
        JSON.stringify({ ...INITIAL, tenant_id: 'independent-tenant', name: 'Independent tenant payload' }), START)
    const independentRows = () => sqlite.prepare(`SELECT * FROM sync_outbox
      WHERE tenant_id <> ? OR aggregate_id <> ? ORDER BY sequence`).all(DEFAULT_TENANT_ID, PRODUCT_ID)
    const before = independentRows()
    const otherBefore = sqlite.prepare('SELECT * FROM products WHERE id = ?').get(otherProduct)
    advanceTime()
    ordinary('LATEST catalog name', 350)

    expectRetired(original)
    expect(independentRows()).toEqual(before)
    expect(sqlite.prepare('SELECT * FROM products WHERE id = ?').get(otherProduct)).toEqual(otherBefore)
    // No startup here: this checks the deliberately tenant-scoped producer,
    // not the separate historical startup coalescing policy.
  })

  it.each(['malformed', 'sending'] as const)('does not retire a %s ordinary request while saving a newer ordinary edit', kind => {
    ordinary()
    const original = rows()[0]
    const protectedId = `protected-${kind}-operation`
    sqlite.prepare(`INSERT INTO sync_outbox (
      operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
      operation_type, payload_json, status, attempts, created_at
    ) VALUES (?, ?, ?, 'product', ?, 'product.upsert', ?, ?, 3, ?)`)
      .run(protectedId, DEFAULT_TENANT_ID, 'legacy-memory-device', PRODUCT_ID,
        kind === 'malformed' ? '{broken-json' : JSON.stringify(INITIAL),
        kind === 'sending' ? 'sending' : 'failed', START)
    const protectedBefore = rows().find(row => row.operation_id === protectedId)!
    advanceTime()
    ordinary('LATEST catalog name', 350)

    expectRetired(original)
    expect(rows().find(row => row.operation_id === protectedId)).toEqual(protectedBefore)
    const latest = rows().find(row => row.status === 'pending')!
    expect(latest.sequence).toBeGreaterThan(protectedBefore.sequence)
    expect(payload(latest)).toMatchObject({ name: 'LATEST catalog name', retail_price: 350, qty_on_hand: 2 })
    // Do not invoke startup/listPending here: legacy repair/retry policies are
    // separate from the producer's promise not to alter protected requests.
  })

  it.each(['insert', 'retirement'] as const)('rolls back the card and complete outbox atomically when %s fails', stage => {
    ordinary()
    const original = rows()[0]
    const before = rows()
    const businessBefore = businessSnapshot()
    const failure = `injected product ${stage} failure`
    if (stage === 'insert') {
      sqlite.exec(`CREATE TRIGGER fail_product_producer BEFORE INSERT ON sync_outbox
        WHEN NEW.aggregate_type = 'product' AND NEW.aggregate_id = '${PRODUCT_ID}'
        BEGIN SELECT RAISE(ABORT, '${failure}'); END`)
    } else {
      sqlite.exec(`CREATE TRIGGER fail_product_producer BEFORE UPDATE ON sync_outbox
        WHEN OLD.sequence = ${original.sequence} AND NEW.status = 'synced'
        BEGIN SELECT RAISE(ABORT, '${failure}'); END`)
    }
    advanceTime()

    expect(() => ordinary('LATEST catalog name', 350)).toThrow(failure)
    expect(sqlite.isTransaction).toBe(false)
    expect(rows()).toEqual(before)
    // Includes stock, prices, search data, movement history, dirty markers and
    // sqlite_sequence: a failed retirement must also roll back the new INSERT.
    expect(businessSnapshot()).toEqual(businessBefore)

    sqlite.exec('DROP TRIGGER fail_product_producer')
    ordinary('LATEST catalog name', 350)
    expectRetired(original)
    expect(rows().filter(row => row.status === 'pending')).toHaveLength(1)
    expect(catalog.findById(PRODUCT_ID)).toMatchObject({ name: 'LATEST catalog name', retail_price: 350, qty_on_hand: 2 })
  })
})
