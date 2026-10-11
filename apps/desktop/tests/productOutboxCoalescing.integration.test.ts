import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_MIGRATIONS } from '../src/db/schema'
import { LocalSyncRepository } from '../src/repositories/syncRepository'

const BEFORE = '2026-09-01T10:00:00.000Z'
const NOW = '2026-10-11T10:00:00.000Z'
const REPLACED = 'Замінено новішою версією товару'
const PRODUCT_IDS = ['a-newest-correction', 'b-older-correction', 'c-deleted-newest', 'd-ordinary', 'e-single']

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
  created_at: string
  synced_at: string | null
  last_error: string | null
}

describe('product outbox coalescing SQLite integration', () => {
  let sqlite: DatabaseSync
  let repository: { coalesceSupersededProductOperations(): void }
  let sequence: number
  let transactionCalls: number

  function insert(table: string, row: Record<string, string | number | null>): void {
    const columns = Object.keys(row)
    sqlite.prepare(`INSERT INTO "${table}" (${columns.map(column => `"${column}"`).join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(row))
  }

  function seedBusinessRows(): void {
    const base = { tenant_id: 'tenant-a', created_at: BEFORE, updated_at: BEFORE }
    const dirty = { ...base, dirty_at: BEFORE, remote_updated_at: '2026-08-01T10:00:00.000Z' }
    for (const [index, id] of PRODUCT_IDS.entries()) {
      insert('products', {
        ...dirty, id, sku: `COALESCE-${index}`, name: `Product ${index}`,
        qty_on_hand: 17.25 + index, purchase_price: 12345, retail_price: 16789,
        notes: 'Local business data must not change', specs_json: '{ "keep": true }',
        deleted_at: id === 'c-deleted-newest' ? BEFORE : null,
      })
      insert('inventory_movements', {
        ...dirty, id: `movement-${index}`, product_id: id, source_type: 'stock_correction',
        source_id: `correction-${index}`, qty_delta: -2.75, qty_after: 17.25 + index, unit_cost: 12345,
      })
    }
    const productId = 'b-older-correction'
    insert('shifts', { ...dirty, id: 'shift-1', cashier_id: 'cashier-1', opened_at: BEFORE, opening_cash: 9876 })
    insert('sales', { ...dirty, id: 'sale-1', sale_number: 'SALE-1', shift_id: 'shift-1', cashier_id: 'cashier-1', total: 16789 })
    insert('sale_items', { ...base, id: 'sale-item-1', sale_id: 'sale-1', product_id: productId, qty: 1, unit_price: 16789, purchase_price: 12345, total: 16789 })
    insert('sale_payments', { ...base, id: 'sale-payment-1', sale_id: 'sale-1', method: 'cash', amount: 16789 })
    insert('cash_operations', { ...dirty, id: 'cash-1', shift_id: 'shift-1', sale_id: 'sale-1', type: 'sale_cash', amount: 16789 })
    insert('inventory_sessions', { ...dirty, id: 'inventory-1', session_name: 'Count', status: 'completed', completed_at: BEFORE })
    insert('inventory_items', { ...base, id: 'inventory-item-1', session_id: 'inventory-1', product_id: productId, expected_stock: 20, counted_stock: 18.25, was_counted: 1 })
    insert('inventory_count_entries', { tenant_id: 'tenant-a', created_at: BEFORE, id: 'count-1', session_id: 'inventory-1', inventory_item_id: 'inventory-item-1', product_id: productId, counted_by: 'cashier-1', qty: 18.25 })
    insert('suppliers', { ...dirty, id: 'supplier-1', name: 'Supplier' })
    insert('supply_invoices', { ...dirty, id: 'invoice-1', supplier_id: 'supplier-1', status: 'posted', total: 24690, paid_amount: 12000 })
    insert('supply_invoice_items', { ...dirty, id: 'invoice-item-1', invoice_id: 'invoice-1', product_id: productId, qty: 2, purchase_price: 12345, total: 24690 })
    insert('supplier_payments', { ...dirty, id: 'supplier-payment-1', invoice_id: 'invoice-1', supplier_id: 'supplier-1', amount: 12000, payment_method: 'cash' })
    insert('warehouse_movements', { ...dirty, id: 'warehouse-1', product_id: productId, from_bin: 'A', to_bin: 'B', qty: 3.5 })
    insert('stock_reserves', { ...dirty, id: 'reserve-1', product_id: productId, qty: 1.5 })
    insert('writeoffs', { ...dirty, id: 'writeoff-1', reason: 'damage' })
    insert('writeoff_items', { ...base, id: 'writeoff-item-1', writeoff_id: 'writeoff-1', product_id: productId, qty: 0.5, cost_kopecks: 6173 })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    // A fresh in-memory schema: no working database, repositories, or network.
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    for (const migration of LOCAL_MIGRATIONS) sqlite.exec(migration.sql)
    seedBusinessRows()
    sequence = 0
    transactionCalls = 0
    const db = {
      prepare: (sql: string) => sqlite.prepare(sql),
      transaction<T>(work: () => T): T {
        transactionCalls++
        sqlite.exec('BEGIN IMMEDIATE')
        try {
          const result = work()
          sqlite.exec('COMMIT')
          return result
        } catch (error) {
          sqlite.exec('ROLLBACK')
          throw error
        }
      },
    }
    // Isolate this method: constructor recoveries would otherwise change dirty
    // flags, retry metadata, and other business state and could hide regressions.
    repository = Object.assign(Object.create(LocalSyncRepository.prototype), { db })
  })

  afterEach(() => {
    sqlite?.close()
    vi.useRealTimers()
  })

  function add(aggregateId: string, overrides: Partial<OutboxRow> = {}): number {
    sequence++
    const row: OutboxRow = {
      sequence,
      operation_id: `operation-${sequence}`,
      tenant_id: 'tenant-a',
      device_id: `device-${sequence % 2}`,
      aggregate_type: 'product',
      aggregate_id: aggregateId,
      operation_type: 'product.upsert',
      payload_json: `{ "name": "original-${sequence}", "qty_on_hand": 999 }`,
      status: sequence % 2 ? 'pending' : 'failed',
      attempts: sequence + 2,
      next_attempt_at: '2026-12-01T10:00:00.000Z',
      // Reverse creation times prove that newest means sequence, not date.
      created_at: new Date(Date.parse(BEFORE) - sequence * 1000).toISOString(),
      synced_at: null,
      last_error: `original-error-${sequence}`,
      ...overrides,
    }
    insert('sync_outbox', row)
    return row.sequence
  }

  function outbox(): OutboxRow[] {
    return sqlite.prepare('SELECT * FROM sync_outbox ORDER BY sequence').all() as OutboxRow[]
  }

  function businessSnapshot(): Record<string, unknown> {
    const tables = sqlite.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name <> 'sync_outbox' ORDER BY name`).all() as Array<{ name: string }>
    // Compare every column and row, not just stock totals or table counts. This
    // includes empty business tables and sqlite_sequence to catch other writes.
    return Object.fromEntries(tables.map(({ name }) => [
      name, sqlite.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all(),
    ]))
  }

  function expectOnlySupersededMetadata(before: OutboxRow[], superseded: number[]): void {
    const changed = new Set(superseded)
    expect(outbox()).toEqual(before.map(row => changed.has(row.sequence) ? {
      ...row, status: 'synced', synced_at: NOW, next_attempt_at: null, last_error: REPLACED,
    } : row))
  }

  it('coalesces eligible rows only, preserves both correction rules and all business data, and is idempotent', () => {
    const superseded = [
      add('b-older-correction', { payload_json: '{"stock_correction":true,"qty_on_hand":10}' }),
      add('a-newest-correction'),
      add('c-deleted-newest', { payload_json: '{"stock_correction":true,"qty_on_hand":0}' }),
      add('d-ordinary', { payload_json: '{"stock_correction":"true"}' }),
    ]
    add('b-older-correction', { status: 'failed', payload_json: '{ "stock_correction": true, "qty_on_hand": 18.25 }' })
    superseded.push(add('c-deleted-newest', { operation_type: 'product.deleted', payload_json: '{"stock_correction":true}' }))
    superseded.push(add('b-older-correction', { payload_json: '{broken-json' }))
    add('a-newest-correction', { status: 'pending', payload_json: '{"stock_correction":true,"qty_on_hand":17.25}' })
    add('b-older-correction', { status: 'pending' })
    superseded.push(add('c-deleted-newest'))
    add('c-deleted-newest', { status: 'failed', operation_type: 'product.deleted' })
    add('d-ordinary', { payload_json: '{"stock_correction":false}' })
    add('e-single', { payload_json: 'null' })

    // These higher sequences must neither be updated nor influence retention.
    for (const status of ['sending', 'synced'] as const) {
      for (const operation_type of ['product.upsert', 'product.deleted']) {
        add('b-older-correction', { status, operation_type, synced_at: status === 'synced' ? BEFORE : null, payload_json: '{"stock_correction":true}' })
      }
    }
    for (const status of ['pending', 'failed'] as const) {
      for (const aggregate_type of ['inventory', 'sale', 'supply_invoice']) {
        add('b-older-correction', { aggregate_type, status, payload_json: '{"stock_correction":true}' })
      }
      for (const operation_type of ['product.created', 'product.updated', 'inventory.completed', 'sale.completed', 'supplier_invoice.posted']) {
        add('b-older-correction', { operation_type, status, payload_json: '{"stock_correction":true}' })
      }
    }
    const before = outbox()
    const businessBefore = businessSnapshot()

    repository.coalesceSupersededProductOperations()

    expectOnlySupersededMetadata(before, superseded)
    expect(businessSnapshot()).toEqual(businessBefore)
    expect(transactionCalls).toBe(1)
    const after = outbox()
    vi.setSystemTime(new Date('2026-10-12T10:00:00.000Z'))
    repository.coalesceSupersededProductOperations()
    expect(outbox()).toEqual(after)
    expect(businessSnapshot()).toEqual(businessBefore)
    expect(transactionCalls).toBe(1)
  })

  it.each(['empty', 'single', 'unique products', 'newest plus latest correction'])('does not write for %s', scenario => {
    if (scenario === 'single') add('e-single')
    if (scenario === 'unique products') {
      add('a-newest-correction')
      add('b-older-correction')
    }
    if (scenario === 'newest plus latest correction') {
      add('b-older-correction', { payload_json: '{"stock_correction":true}' })
      add('b-older-correction')
    }
    const before = outbox()
    const businessBefore = businessSnapshot()

    repository.coalesceSupersededProductOperations()

    expect(outbox()).toEqual(before)
    expect(businessSnapshot()).toEqual(businessBefore)
    expect(transactionCalls).toBe(0)
  })

  it('preserves existing aggregate-id grouping across tenant and device metadata', () => {
    const obsolete = add('b-older-correction', { tenant_id: 'tenant-a', device_id: 'device-a' })
    add('b-older-correction', { tenant_id: 'tenant-b', device_id: 'device-b', payload_json: '{"stock_correction":true}' })
    add('b-older-correction', { tenant_id: 'tenant-c', device_id: 'device-c' })
    const before = outbox()
    const businessBefore = businessSnapshot()

    repository.coalesceSupersededProductOperations()

    expectOnlySupersededMetadata(before, [obsolete])
    expect(businessSnapshot()).toEqual(businessBefore)
  })

  it('rolls back earlier updates when a later SQLite UPDATE fails', () => {
    const oldest = add('d-ordinary')
    const fails = add('d-ordinary')
    const firstUpdated = add('d-ordinary')
    add('d-ordinary')
    const attempted: number[] = []
    sqlite.function('record_coalescing_update', value => {
      attempted.push(Number(value))
      return null
    })
    sqlite.exec(`CREATE TRIGGER fail_coalescing_update BEFORE UPDATE ON sync_outbox BEGIN
      SELECT record_coalescing_update(NEW.sequence);
      SELECT CASE WHEN NEW.sequence = ${fails} THEN RAISE(ABORT, 'injected coalescing UPDATE failure') END;
    END`)
    const before = outbox()
    const businessBefore = businessSnapshot()

    expect(() => repository.coalesceSupersededProductOperations()).toThrow('injected coalescing UPDATE failure')

    expect(attempted).toEqual([firstUpdated, fails])
    expect(transactionCalls).toBe(1)
    expect(sqlite.isTransaction).toBe(false)
    expect(outbox()).toEqual(before)
    expect(businessSnapshot()).toEqual(businessBefore)

    sqlite.exec('DROP TRIGGER fail_coalescing_update')
    repository.coalesceSupersededProductOperations()
    expectOnlySupersededMetadata(before, [oldest, fails, firstUpdated])
    expect(businessSnapshot()).toEqual(businessBefore)
    expect(transactionCalls).toBe(2)
  })
})
