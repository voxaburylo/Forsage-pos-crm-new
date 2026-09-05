import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalSyncRepository } from '../src/repositories/syncRepository'
import { MAX_OUTBOX_ATTEMPTS } from '../src/repositories/outboxPolicy'

/** Далеке майбутнє: рядок точно не потрапить у звичайну чергу за часом. */
const BACKOFF_AT = '2099-01-01T00:00:00.000Z'

describe('LocalSyncRepository stuck-operation recovery', () => {
  let root = ''
  let db: LocalDatabase
  let repository: LocalSyncRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-sync-stuck-'))
    db = new LocalDatabase(root)
    repository = new LocalSyncRepository(db)
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  function insertOperation(options: {
    sequence: number
    attempts: number
    status: 'pending' | 'failed'
    operationType?: string
    payload?: unknown
  }): void {
    db.prepare(`
      INSERT INTO sync_outbox(
        sequence, operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, attempts, next_attempt_at, created_at, last_error
      ) VALUES (?, ?, ?, 'device-1', 'sale', ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', 'boom')
    `).run(
      options.sequence,
      `operation-${options.sequence}`,
      DEFAULT_TENANT_ID,
      `aggregate-${options.sequence}`,
      options.operationType ?? 'sale.created',
      JSON.stringify(options.payload ?? {}),
      options.status,
      options.attempts,
      BACKOFF_AT,
    )
  }

  it('lists only operations that exhausted their retries', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS, status: 'failed' })
    insertOperation({ sequence: 2, attempts: MAX_OUTBOX_ATTEMPTS - 1, status: 'failed' })
    insertOperation({ sequence: 3, attempts: 0, status: 'pending' })

    const stuck = repository.listStuck()

    expect(stuck).toHaveLength(1)
    expect(stuck[0].sequence).toBe(1)
    expect(stuck[0].operation_type).toBe('sale.created')
    expect(stuck[0].last_error).toBe('boom')
    // Payload навмисно не віддаємо в UI — він може важити сотні кілобайт.
    expect(stuck[0]).not.toHaveProperty('payload')
  })

  it('requeues stuck operations and reports how many moved', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS, status: 'failed' })
    insertOperation({ sequence: 2, attempts: MAX_OUTBOX_ATTEMPTS + 5, status: 'failed' })

    expect(repository.retryStuck()).toEqual({ retried: 2 })
    expect(repository.listStuck()).toHaveLength(0)

    const rows = db.prepare(
      'SELECT status, attempts, next_attempt_at, last_error FROM sync_outbox ORDER BY sequence',
    ).all() as Array<{ status: string; attempts: number; next_attempt_at: string | null; last_error: string | null }>
    for (const row of rows) {
      expect(row.status).toBe('pending')
      expect(row.attempts).toBe(0)
      expect(row.next_attempt_at).toBeNull()
      expect(row.last_error).toBeNull()
    }
  })

  it('never resets operations that are still retrying on their own', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS - 1, status: 'failed' })

    expect(repository.retryStuck()).toEqual({ retried: 0 })

    const row = db.prepare(
      'SELECT status, attempts, next_attempt_at FROM sync_outbox WHERE sequence = 1',
    ).get() as { status: string; attempts: number; next_attempt_at: string | null }
    // Скидання backoff у рядка, який ще ретраїться сам, влаштувало б шторм запитів.
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(MAX_OUTBOX_ATTEMPTS - 1)
    expect(row.next_attempt_at).toBe(BACKOFF_AT)
  })

  it('retries only the selected operation when the user picks one row', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS, status: 'failed' })
    insertOperation({ sequence: 2, attempts: MAX_OUTBOX_ATTEMPTS, status: 'failed' })

    expect(repository.retryStuck([2])).toEqual({ retried: 1 })

    const remaining = repository.listStuck()
    expect(remaining.map((operation) => operation.sequence)).toEqual([1])
  })

  it('ignores an empty selection instead of requeuing everything', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS, status: 'failed' })

    expect(repository.retryStuck([])).toEqual({ retried: 0 })
    expect(repository.listStuck()).toHaveLength(1)
  })

  it('відмовляється від застряглої операції і лишає слід у журналі проблем', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS, status: 'failed', operationType: 'inventory.completed' })

    expect(repository.discardStuck([1])).toEqual({ discarded: 1, corrected: 0 })
    expect(repository.listStuck()).toHaveLength(0)

    const row = db.prepare(
      'SELECT status, synced_at, next_attempt_at, last_error FROM sync_outbox WHERE sequence = 1',
    ).get() as { status: string; synced_at: string | null; next_attempt_at: string | null; last_error: string | null }
    expect(row.status).toBe('synced')
    expect(row.synced_at).toBeTruthy()
    expect(row.next_attempt_at).toBeNull()
    // Причину відмови видно прямо в черзі: інакше через місяць ніхто не згадає.
    expect(row.last_error).toContain('за рішенням власника')
    expect(row.last_error).toContain('boom')

    const problems = db.prepare(
      "SELECT code, severity, entity_id FROM problem_log WHERE code = 'sync.operation_discarded'",
    ).all() as Array<{ code: string; severity: string; entity_id: string | null }>
    expect(problems).toHaveLength(1)
    expect(problems[0].severity).toBe('warning')
    expect(problems[0].entity_id).toBe('aggregate-1')
  })

  it('не дає відмовитись від операції, яка ще ретраїться сама', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS - 1, status: 'failed' })

    // Наступна спроба ще може пройти — відмовлятися рано.
    expect(repository.discardStuck([1])).toEqual({ discarded: 0, corrected: 0 })

    const row = db.prepare('SELECT status, attempts FROM sync_outbox WHERE sequence = 1')
      .get() as { status: string; attempts: number }
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(MAX_OUTBOX_ATTEMPTS - 1)
  })

  it('порожній список нічого не знімає з черги', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS, status: 'failed' })

    expect(repository.discardStuck([])).toEqual({ discarded: 0, corrected: 0 })
    expect(repository.listStuck()).toHaveLength(1)
  })

  it('знімає з черги лише вибрані рядки', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS, status: 'failed' })
    insertOperation({ sequence: 2, attempts: MAX_OUTBOX_ATTEMPTS, status: 'failed' })

    expect(repository.discardStuck([2])).toEqual({ discarded: 1, corrected: 0 })
    expect(repository.listStuck().map((operation) => operation.sequence)).toEqual([1])
  })

  it('після відмови надсилає на сервер залишок з каси', () => {
    const productId = 'ffffffff-0000-4000-8000-000000000001'
    db.prepare(`
      INSERT INTO products(id, tenant_id, sku, name, qty_on_hand, created_at, updated_at)
      VALUES (?, ?, 'SKU-1', 'Олива тестова', 7, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run(productId, DEFAULT_TENANT_ID)
    insertOperation({
      sequence: 1,
      attempts: MAX_OUTBOX_ATTEMPTS,
      status: 'failed',
      operationType: 'inventory.completed',
      payload: { items: [{ product_id: productId, counted_stock: 3 }] },
    })

    expect(repository.discardStuck([1])).toEqual({ discarded: 1, corrected: 1 })

    const correction = db.prepare(`
      SELECT operation_type, status, payload_json FROM sync_outbox
      WHERE aggregate_id = ? AND operation_type = 'product.upsert'
    `).get(productId) as { operation_type: string; status: string; payload_json: string }
    expect(correction.status).toBe('pending')
    const payload = JSON.parse(correction.payload_json)
    // Кількість — з каси, а не з відкинутої ревізії.
    expect(payload.qty_on_hand).toBe(7)
    expect(payload.stock_correction).toBe(true)
    // Ціни свідомо не чіпаємо: у вебі вони могли змінитися.
    expect(payload).not.toHaveProperty('retail_price')
    expect(payload).not.toHaveProperty('purchase_price')
  })

  it('не вигадує виправлення для товару, якого на касі вже немає', () => {
    insertOperation({
      sequence: 1,
      attempts: MAX_OUTBOX_ATTEMPTS,
      status: 'failed',
      operationType: 'sale.completed',
      payload: { items: [{ product_id: 'ffffffff-0000-4000-8000-000000000009' }] },
    })

    expect(repository.discardStuck([1])).toEqual({ discarded: 1, corrected: 0 })
    expect(db.prepare("SELECT COUNT(*) n FROM sync_outbox WHERE operation_type = 'product.upsert'").get())
      .toEqual({ n: 0 })
  })

  it('counts exhausted operations as stuck in the health summary', () => {
    insertOperation({ sequence: 1, attempts: MAX_OUTBOX_ATTEMPTS, status: 'failed' })
    insertOperation({ sequence: 2, attempts: 2, status: 'failed' })
    insertOperation({ sequence: 3, attempts: 0, status: 'pending' })

    const status = repository.getSyncStatus()

    expect(status.stuck).toBe(1)
    expect(status.retrying).toBe(1)
    expect(status.pending).toBe(1)
    expect(status.total).toBe(3)
  })
})
